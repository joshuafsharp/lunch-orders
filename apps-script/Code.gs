/**
 * Weekly Lunch Orders — backend.
 *
 * THE ONE RULE: no public endpoint ever reads the Orders tab.
 * doGet returns menu data only. doPost returns {ok:true} and nothing else.
 * Every change to these two functions is a security change.
 *
 * Script timezone is Australia/Sydney (appsscript.json), so bare Date
 * constructors below are Sydney local time. Do not change one without the other.
 */

var MENU_SHEET = 'Menu';
var ORDERS_SHEET = 'Orders';

var PAYID = '04XX XXX XXX'; // shown in the receipt email ONLY. Never in doGet.
var BUSINESS_NAME = 'Lunch';

var MAX_QTY_PER_LINE = 5;
var MAX_LINES = 10;
var MIN_FORM_SECONDS = 3; // faster than this and it wasn't a human

var MENU_COLS = ['week', 'status', 'id', 'name', 'description', 'price', 'allergens', 'media'];
var ORDER_COLS = ['order_id', 'timestamp', 'week', 'name', 'email', 'dish_id',
                  'qty', 'unit_price', 'line_total', 'notes', 'void', 'paid'];

// ---------------------------------------------------------------- endpoints

function doGet(e) {
  var view = (e && e.parameter && e.parameter.view) || 'live';
  try {
    return json(view === 'archive' ? archivePayload() : livePayload());
  } catch (err) {
    return json({ error: 'unavailable' });
  }
}

function doPost(e) {
  try {
    return json(handleOrder(e));
  } catch (err) {
    // Never leak the exception — it can name sheets, ranges and row contents.
    return json({ ok: false, error: 'Something broke. Try again, or message me.' });
  }
}

// ---------------------------------------------------------------- read side

function livePayload() {
  var dishes = readMenu().filter(function (d) { return d.status === 'live'; });
  if (!dishes.length) return { week: null, is_open: false, closes_at: null, dishes: [] };

  var week = dishes[0].week;
  dishes = dishes.filter(function (d) { return d.week === week; });
  var cutoff = cutoffFor(week);

  return {
    week: week,
    is_open: new Date() <= cutoff,
    closes_at: cutoff.toISOString(),
    dishes: dishes.map(publicDish)
  };
}

function archivePayload() {
  var byWeek = {};
  readMenu().forEach(function (d) {
    if (d.status !== 'archive') return;
    (byWeek[d.week] = byWeek[d.week] || []).push(publicDish(d));
  });
  var weeks = Object.keys(byWeek).sort().reverse().map(function (w) {
    return { week: w, dishes: byWeek[w] };
  });
  return { weeks: weeks };
}

/** Whitelist, not blacklist. A new sheet column must not become public by accident. */
function publicDish(d) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    price: d.price,
    allergens: d.allergens,
    media: d.media
  };
}

// ---------------------------------------------------------------- write side

function handleOrder(e) {
  var body = parseBody(e);
  if (!body) return { ok: false, error: 'Bad request.' };

  // Honeypot: pretend it worked, write nothing.
  if (String(body.website || '').trim() !== '') return { ok: true };

  var elapsed = (Number(body.elapsed_ms) || 0) / 1000;
  if (elapsed < MIN_FORM_SECONDS) return { ok: false, error: 'That was quick. Try again.' };

  var name = clean(body.name, 80);
  var email = clean(body.email, 120);
  var notes = clean(body.notes, 500);
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'That email looks wrong.' };

  var menu = readMenu().filter(function (d) { return d.status === 'live'; });
  if (!menu.length) return { ok: false, error: 'No menu is live right now.' };

  var week = menu[0].week;
  if (new Date() > cutoffFor(week)) return { ok: false, error: 'Orders for this week are closed.' };

  var byId = {};
  menu.forEach(function (d) { if (d.week === week) byId[d.id] = d; });

  var items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { ok: false, error: 'Your order is empty.' };
  if (items.length > MAX_LINES) return { ok: false, error: 'Too many items.' };

  var lines = [];
  var seen = {};
  for (var i = 0; i < items.length; i++) {
    var dish = byId[String(items[i].id)];
    if (!dish) return { ok: false, error: 'That dish is not on this week\'s menu.' };
    if (seen[dish.id]) return { ok: false, error: 'Duplicate dish in the order.' };
    seen[dish.id] = true;

    var qty = Math.floor(Number(items[i].qty));
    if (!(qty >= 1 && qty <= MAX_QTY_PER_LINE)) {
      return { ok: false, error: 'Quantities must be 1–' + MAX_QTY_PER_LINE + ' per dish.' };
    }
    // Price comes from the sheet, never from the client.
    lines.push({ dish: dish, qty: qty, unit: dish.price, total: round2(dish.price * qty) });
  }

  var orderId = 'ord_' + Utilities.getUuid().slice(0, 8);
  var now = new Date();
  var sheet = SpreadsheetApp.getActive().getSheetByName(ORDERS_SHEET);
  var rows = lines.map(function (l) {
    return [orderId, now, week, name, email, l.dish.id, l.qty, l.unit, l.total, notes, false, false];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ORDER_COLS.length).setValues(rows);

  sendReceipt(email, name, week, lines);
  return { ok: true };
}

function parseBody(e) {
  if (!e || !e.postData || !e.postData.contents) return null;
  try { return JSON.parse(e.postData.contents); } catch (err) { return null; }
}

// ---------------------------------------------------------------- receipt

function sendReceipt(email, name, week, lines) {
  var total = round2(lines.reduce(function (s, l) { return s + l.total; }, 0));
  var body = ['Thanks ' + name + ' — order in for ' + fmtWeek(week) + '.', ''];
  lines.forEach(function (l) {
    body.push(l.qty + ' × ' + l.dish.name + '  —  $' + l.total.toFixed(2));
  });
  body.push('', 'Total: $' + total.toFixed(2), '',
            'Pay by PayID: ' + PAYID, 'or cash on delivery Monday.', '',
            'Need to change something? Just reply to this email.');

  try {
    MailApp.sendEmail({
      to: email,
      subject: BUSINESS_NAME + ' — order confirmed for ' + fmtWeek(week),
      body: body.join('\n')
    });
  } catch (err) {
    // A bad address must not lose the order — the row is already written.
    console.warn('receipt failed: ' + err);
  }
}

// ---------------------------------------------------------------- sheet io

function readMenu() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(MENU_SHEET);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var head = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var idx = {};
  MENU_COLS.forEach(function (c) { idx[c] = head.indexOf(c); });

  return values.slice(1).map(function (row) {
    var media = String(row[idx.media] || '').split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    return {
      week: weekKey(row[idx.week]),
      status: String(row[idx.status] || '').trim().toLowerCase(),
      id: String(row[idx.id] || '').trim(),
      name: String(row[idx.name] || '').trim(),
      description: String(row[idx.description] || '').trim(),
      price: round2(Number(row[idx.price]) || 0),
      allergens: String(row[idx.allergens] || '').trim(),
      media: media
    };
  }).filter(function (d) { return d.id && d.name && d.week; });
}

// ---------------------------------------------------------------- dates

/** Sheet week cell may be a Date or a YYYY-MM-DD string. Normalise to the string. */
function weekKey(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** Delivery Monday → Friday 5pm of the week before. Script tz is Sydney. */
function cutoffFor(week) {
  var p = week.split('-');
  var monday = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 3, 17, 0, 0);
}

function fmtWeek(week) {
  var p = week.split('-');
  return Utilities.formatDate(
    new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])),
    Session.getScriptTimeZone(), 'EEE d MMM');
}

// ---------------------------------------------------------------- misc

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------- admin

/** Run once from the editor to create both tabs with headers. */
function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  [[MENU_SHEET, MENU_COLS], [ORDERS_SHEET, ORDER_COLS]].forEach(function (pair) {
    var sheet = ss.getSheetByName(pair[0]) || ss.insertSheet(pair[0]);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, pair[1].length).setValues([pair[1]]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });
}

/** Time-based trigger, Wednesday morning. Set the recipients before enabling. */
function wednesdayReminder() {
  var live = livePayload();
  if (!live.week || !live.is_open) return;
  var names = live.dishes.map(function (d) { return '• ' + d.name + ' — $' + d.price.toFixed(2); });
  MailApp.sendEmail({
    to: PropertiesService.getScriptProperties().getProperty('REMINDER_TO') || '',
    subject: BUSINESS_NAME + ' — orders close Friday',
    body: ['This week (' + fmtWeek(live.week) + '):', ''].concat(names)
      .concat(['', 'Order: ' + (PropertiesService.getScriptProperties().getProperty('PAGE_URL') || '')])
      .join('\n')
  });
}

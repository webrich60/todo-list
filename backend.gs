/**
 * TODO管理アプリ バックエンド（v2.6.4 端末間同期修正版）
 * - GitHub Pages側とのJSONP読込／一括保存
 * - 完了状態・完了日時を保持
 * - 既存の旧ヘッダーも読込可能
 * - 同時保存によるデータ破損をLockServiceで防止
 */

const TODO_SHEET_NAME = 'TODO管理';
const TODO_CATEGORY_SHEET_NAME = 'TODOカテゴリ';
const TODO_NOTIFICATION_DEVICE_SHEET_NAME = 'TODO通知端末';
const TODO_NOTIFICATION_TIMEZONE = 'Asia/Tokyo';
const TODO_DEFAULT_CATEGORIES = ['未分類', '仕事', 'プライベート', '旅行', '観光', '遊び', '外食', '病院'];
const TODO_HEADERS = [
  'ID', '種別', 'タイトル', '詳細', 'カテゴリ', '優先度', '期限', '終了日時',
  'カラー', 'ステータス', 'メール通知', 'プッシュ通知', '完了日時', '更新日時'
];

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (String(params.action || '') === 'categories') {
      return jsonpResponse_(readCategories_(), params.callback);
    }
    if (String(params.action || '') === 'notificationStatus') {
      const status = getFcmConfigStatus_();
      return jsonpResponse_({
        configured: status.configured,
        reason: status.reason,
        deviceCount: readPushTokens_().length
      }, params.callback);
    }
    const todos = readTodos_();
    return jsonpResponse_(todos, params.callback);
  } catch (error) {
    return jsonpResponse_({ ok: false, error: String(error && error.message || error) },
      e && e.parameter && e.parameter.callback);
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const body = e && e.postData && e.postData.contents;
    if (!body) throw new Error('保存データが空です。');

    const parsed = JSON.parse(body);
    if (parsed && !Array.isArray(parsed) && parsed.action === 'saveCategories') {
      const categories = normalizeCategories_(parsed.categories);
      writeCategories_(categories);
      return jsonResponse_({ ok: true, count: categories.length });
    }
    if (parsed && !Array.isArray(parsed) && parsed.action === 'deleteTodo') {
      const id = String(parsed.id || '');
      if (!id) throw new Error('削除するTODOのIDがありません。');
      const existing = readTodos_();
      const remaining = existing.filter(function (item) {
        return String(item.id) !== id;
      });
      if (remaining.length === existing.length) {
        return jsonResponse_({ ok: true, deleted: false, count: remaining.length });
      }
      writeTodos_(remaining, { allowEmpty: true });
      return jsonResponse_({ ok: true, deleted: true, count: remaining.length });
    }
    if (parsed && !Array.isArray(parsed) && parsed.action === 'registerPushToken') {
      const token = String(parsed.token || '').trim();
      if (!token) throw new Error('通知端末トークンがありません。');
      registerPushToken_(token, String(parsed.userAgent || ''));
      return jsonResponse_({ ok: true });
    }
    if (parsed && !Array.isArray(parsed) && parsed.action === 'unregisterPushToken') {
      const token = String(parsed.token || '').trim();
      if (token) unregisterPushToken_(token);
      return jsonResponse_({ ok: true });
    }
    if (parsed && !Array.isArray(parsed) && parsed.action === 'testPushToken') {
      const token = String(parsed.token || '').trim();
      if (!token) throw new Error('通知端末トークンがありません。');
      sendFcmToToken_(token, {
        title: '🔔 TODO管理 テスト通知',
        body: 'スマホ通知の設定は正常です。',
        targetDate: Utilities.formatDate(new Date(), TODO_NOTIFICATION_TIMEZONE, 'yyyy-MM-dd'),
        tag: 'todo-test-' + Date.now()
      });
      return jsonResponse_({ ok: true });
    }
    if (!Array.isArray(parsed)) throw new Error('保存データの形式が正しくありません。');

    const normalized = parsed.map(normalizeTodo_).filter(function (item) {
      return item.title !== '';
    });

    // 端末側が空・一部だけの状態でも、クラウド上の既存TODOを消さない。
    // 削除は deleteTodo アクションでだけ明示的に行う。
    if (normalized.length === 0) {
      return jsonResponse_({ ok: true, count: readTodos_().length, skippedEmptyWrite: true });
    }

    const existing = readTodos_();
    const mergedById = {};
    existing.forEach(function (item) {
      mergedById[String(item.id)] = item;
    });
    normalized.forEach(function (incoming) {
      const key = String(incoming.id);
      const current = mergedById[key];
      if (shouldReplaceTodo_(current, incoming)) {
        mergedById[key] = incoming;
      }
    });
    const merged = Object.keys(mergedById).map(function (key) {
      return mergedById[key];
    });
    writeTodos_(merged);
    return jsonResponse_({ ok: true, count: merged.length });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error && error.message || error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function readTodos_() {
  const sheet = getTodoSheet_();
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const headers = values[0].map(function (value) { return String(value).trim(); });
  const column = {
    id: findHeader_(headers, ['ID', 'id']),
    type: findHeader_(headers, ['種別', 'タイプ', 'タスク名', 'type']),
    title: findHeader_(headers, ['タイトル', 'タスク', 'title']),
    description: findHeader_(headers, ['詳細', '説明', 'description']),
    category: findHeader_(headers, ['カテゴリ', '分類', 'category']),
    priority: findHeader_(headers, ['優先度', 'priority']),
    dueDate: findHeader_(headers, ['期限', '開始・期限', 'dueDate']),
    endDate: findHeader_(headers, ['終了日時', '終了', 'endDate']),
    color: findHeader_(headers, ['カラー', '色', 'color']),
    status: findHeader_(headers, ['ステータス', '状態', 'status']),
    mailNotify: findHeader_(headers, ['メール通知', '通知', 'mailNotify']),
    pushNotify: findHeader_(headers, ['プッシュ通知', 'スマホ通知', 'pushNotify']),
    completedAt: findHeader_(headers, ['完了日時', 'completedAt']),
    updatedAt: findHeader_(headers, ['更新日時', 'updatedAt', 'modifiedAt'])
  };

  return values.slice(1).map(function (row, index) {
    const rawType = cell_(row, column.type);
    const rawStatus = cell_(row, column.status);
    return normalizeTodo_({
      id: cell_(row, column.id) || String(Date.now() + index),
      type: rawType,
      title: cell_(row, column.title),
      description: cell_(row, column.description),
      category: cell_(row, column.category),
      priority: cell_(row, column.priority),
      dueDate: cell_(row, column.dueDate),
      endDate: cell_(row, column.endDate),
      color: cell_(row, column.color),
      status: rawStatus,
      mailNotify: cell_(row, column.mailNotify),
      pushNotify: cell_(row, column.pushNotify),
      completedAt: cell_(row, column.completedAt),
      updatedAt: cell_(row, column.updatedAt)
    });
  }).filter(function (item) { return item.title !== ''; });
}

function writeTodos_(todos, options) {
  options = options || {};
  const sheet = getTodoSheet_();
  const rows = todos.map(function (todo) {
    return [
      todo.id,
      todo.type,
      todo.title,
      todo.description,
      todo.category,
      todo.priority,
      todo.dueDate,
      todo.endDate,
      todo.color,
      todo.status,
      todo.mailNotify,
      todo.pushNotify,
      todo.completedAt,
      todo.updatedAt || new Date().toISOString()
    ];
  });

  if (!rows.length && !options.allowEmpty) {
    throw new Error('安全のため、空データでTODO管理シートを上書きしません。');
  }

  backupTodoSheet_(sheet);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, TODO_HEADERS.length).setValues([TODO_HEADERS]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, TODO_HEADERS.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, TODO_HEADERS.length);
}

function backupTodoSheet_(sourceSheet) {
  const spreadsheet = sourceSheet.getParent();
  const backupName = 'TODO管理_直前バックアップ';
  let backup = spreadsheet.getSheetByName(backupName);
  if (!backup) backup = spreadsheet.insertSheet(backupName);

  const values = sourceSheet.getDataRange().getValues();
  backup.clearContents();
  if (values.length && values[0].length) {
    backup.getRange(1, 1, values.length, values[0].length).setValues(values);
  }
  backup.getRange(1, Math.max(1, sourceSheet.getLastColumn() + 2)).setValue(
    'バックアップ日時: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')
  );
}

function normalizeTodo_(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const rawStatus = String(raw.status || '');
  const status = rawStatus === 'チェック済'
    ? '完了'
    : (['未完了', '完了'].indexOf(rawStatus) >= 0
      ? rawStatus
      : (toBoolean_(raw.completed) ? '完了' : '未完了'));
  const rawType = String(raw.type || '').toLowerCase();
  const type = rawType === 'memo' || rawType === 'メモ' || rawType === '記憶・メモ'
    ? 'memo' : 'todo';
  return {
    id: Number(raw.id) || Date.now(),
    type: type,
    title: String(raw.title || '').trim(),
    description: String(raw.description || ''),
    category: String(raw.category || '未分類').trim() || '未分類',
    priority: ['高', '中', '低'].indexOf(String(raw.priority)) >= 0 ? String(raw.priority) : '中',
    dueDate: String(raw.dueDate || ''),
    endDate: String(raw.endDate || ''),
    color: String(raw.color || 'blue'),
    status: status,
    mailNotify: toBoolean_(raw.mailNotify),
    pushNotify: raw.pushNotify === '' || raw.pushNotify === undefined || raw.pushNotify === null
      ? true : toBoolean_(raw.pushNotify),
    completedAt: status === '完了' ? String(raw.completedAt || new Date().toISOString()) : '',
    updatedAt: String(raw.updatedAt || raw.modifiedAt || '')
  };
}

function normalizeCategories_(values) {
  const source = TODO_DEFAULT_CATEGORIES.concat(Array.isArray(values) ? values : []);
  const seen = {};
  return source.map(function (value) {
      if (value && typeof value === 'object') {
        return String(value.category || value.name || value.value || '').trim();
      }
      return String(value || '').trim();
    })
    .filter(function (value) {
      if (!value || value === '[object Object]' || seen[value]) return false;
      seen[value] = true;
      return true;
    });
}

function readCategories_() {
  const sheet = getCategorySheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return TODO_DEFAULT_CATEGORIES.slice();
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues()
    .map(function (row) { return row[0]; });
  return normalizeCategories_(values);
}

function writeCategories_(categories) {
  const sheet = getCategorySheet_();
  const normalized = normalizeCategories_(categories);
  sheet.clearContents();
  sheet.getRange(1, 1).setValue('カテゴリ');
  if (normalized.length) {
    sheet.getRange(2, 1, normalized.length, 1).setValues(
      normalized.map(function (value) { return [value]; })
    );
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumn(1);
}

function getCategorySheet_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  const spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('スプレッドシートを取得できません。SPREADSHEET_IDをスクリプトプロパティへ設定してください。');
  }
  let sheet = spreadsheet.getSheetByName(TODO_CATEGORY_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(TODO_CATEGORY_SHEET_NAME);
    writeInitialCategories_(sheet);
  }
  return sheet;
}

function writeInitialCategories_(sheet) {
  sheet.getRange(1, 1).setValue('カテゴリ');
  sheet.getRange(2, 1, TODO_DEFAULT_CATEGORIES.length, 1).setValues(
    TODO_DEFAULT_CATEGORIES.map(function (value) { return [value]; })
  );
  sheet.setFrozenRows(1);
  sheet.autoResizeColumn(1);
}

function getTodoSheet_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  const spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('スプレッドシートを取得できません。SPREADSHEET_IDをスクリプトプロパティへ設定してください。');
  }
  const namedSheet = spreadsheet.getSheetByName(TODO_SHEET_NAME);
  if (namedSheet) return namedSheet;

  // 旧版は「現在開いているシート」を使用していたため、既存データのあるシートを優先する。
  const sheets = spreadsheet.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const lastColumn = sheets[i].getLastColumn();
    if (lastColumn < 1) continue;
    const headers = sheets[i].getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    if (headers.indexOf('ID') >= 0 && headers.indexOf('タイトル') >= 0) return sheets[i];
  }
  if (sheets.length) return sheets[0];
  return spreadsheet.insertSheet(TODO_SHEET_NAME);
}

function findHeader_(headers, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const index = headers.indexOf(candidates[i]);
    if (index >= 0) return index;
  }
  return -1;
}

function cell_(row, index) {
  return index >= 0 && index < row.length ? row[index] : '';
}

function toBoolean_(value) {
  return value === true || ['true', '1', 'yes', 'on', 'はい', '有効'].indexOf(String(value).toLowerCase()) >= 0;
}

function updatedTime_(todo) {
  const time = new Date(todo && todo.updatedAt ? todo.updatedAt : 0).getTime();
  return isNaN(time) ? 0 : time;
}

function shouldReplaceTodo_(current, incoming) {
  if (!current) return true;
  const incomingTime = updatedTime_(incoming);
  const currentTime = updatedTime_(current);
  if (incomingTime > currentTime) return true;
  if (incomingTime < currentTime) return false;

  // 旧端末は更新日時を送らないため、同時刻（主に0対0）の場合に
  // すでに完了したタスクを未完了へ巻き戻さない。
  return !(current.status === '完了' && incoming.status !== '完了');
}

function jsonpResponse_(payload, callback) {
  const json = JSON.stringify(payload);
  const validCallback = String(callback || '').match(/^[A-Za-z_$][0-9A-Za-z_$]*$/);
  if (!validCallback) return jsonResponse_(payload);
  return ContentService.createTextOutput(validCallback[0] + '(' + json + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * スマホPush通知（Firebase Cloud Messaging / HTTP v1）
 * 必要なスクリプトプロパティ:
 *   FCM_SERVICE_ACCOUNT_JSON（推奨：サービスアカウントJSON全文）
 *   または FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY
 *   TODO_APP_URL 例: https://ユーザー名.github.io/リポジトリ名/
 */
function getFcmCredentials_() {
  const p = PropertiesService.getScriptProperties();
  const json = String(p.getProperty('FCM_SERVICE_ACCOUNT_JSON') || '').trim();
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: String(parsed.project_id),
          clientEmail: String(parsed.client_email),
          privateKey: String(parsed.private_key)
        };
      }
    } catch (error) {
      throw new Error('FCM_SERVICE_ACCOUNT_JSON のJSON形式が正しくありません。');
    }
  }
  const projectId = p.getProperty('FCM_PROJECT_ID');
  const clientEmail = p.getProperty('FCM_CLIENT_EMAIL');
  const privateKey = p.getProperty('FCM_PRIVATE_KEY');
  if (projectId && clientEmail && privateKey) {
    return { projectId: projectId, clientEmail: clientEmail, privateKey: privateKey };
  }
  return null;
}

function getFcmConfigStatus_() {
  try {
    const credentials = getFcmCredentials_();
    if (!credentials) {
      return {
        configured: false,
        reason: 'FCM_SERVICE_ACCOUNT_JSON が未設定、または project_id / client_email / private_key が不足しています。'
      };
    }
    return { configured: true, reason: '設定済み' };
  } catch (error) {
    return {
      configured: false,
      reason: String(error && error.message || error)
    };
  }
}

function hasFcmServerConfig_() {
  return getFcmConfigStatus_().configured;
}

function getNotificationDeviceSheet_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  const spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('スプレッドシートを取得できません。');
  let sheet = spreadsheet.getSheetByName(TODO_NOTIFICATION_DEVICE_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(TODO_NOTIFICATION_DEVICE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['FCMトークン', '端末情報', '有効', '更新日時']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function registerPushToken_(token, userAgent) {
  const sheet = getNotificationDeviceSheet_();
  const lastRow = sheet.getLastRow();
  const values = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 4).getValues() : [];
  const rowIndex = values.findIndex(function (row) { return String(row[0]) === token; });
  const row = [token, userAgent, true, new Date().toISOString()];
  if (rowIndex >= 0) {
    sheet.getRange(rowIndex + 2, 1, 1, 4).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function unregisterPushToken_(token) {
  const sheet = getNotificationDeviceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  values.forEach(function (row, index) {
    if (String(row[0]) === token) {
      sheet.getRange(index + 2, 3).setValue(false);
      sheet.getRange(index + 2, 4).setValue(new Date().toISOString());
    }
  });
}

function readPushTokens_() {
  const sheet = getNotificationDeviceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 4).getValues()
    .filter(function (row) {
      return String(row[0]).trim() && row[2] !== false && String(row[2]).toUpperCase() !== 'FALSE';
    })
    .map(function (row) { return String(row[0]).trim(); });
}

function disablePushToken_(token) {
  unregisterPushToken_(token);
}

function base64UrlEncode_(value) {
  const bytes = typeof value === 'string' ? Utilities.newBlob(value).getBytes() : value;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function getFcmAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('FCM_ACCESS_TOKEN');
  if (cached) return cached;

  const credentials = getFcmCredentials_();
  if (!credentials || !credentials.clientEmail || !credentials.privateKey) {
    throw new Error('FCMサービスアカウント設定がありません。');
  }
  const clientEmail = credentials.clientEmail;
  const privateKey = String(credentials.privateKey).replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlEncode_(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsignedJwt = header + '.' + claim;
  const signature = Utilities.computeRsaSha256Signature(unsignedJwt, privateKey);
  const assertion = unsignedJwt + '.' + base64UrlEncode_(signature);

  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion
    },
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) throw new Error('FCM認証エラー: ' + body);
  const accessToken = JSON.parse(body).access_token;
  if (!accessToken) throw new Error('FCMアクセストークンを取得できません。');
  cache.put('FCM_ACCESS_TOKEN', accessToken, 3300);
  return accessToken;
}

function sendFcmToToken_(token, notification) {
  if (!hasFcmServerConfig_()) throw new Error('FCM送信設定が未設定です。');
  const properties = PropertiesService.getScriptProperties();
  const credentials = getFcmCredentials_();
  if (!credentials) throw new Error('FCMサービスアカウント設定がありません。');
  const projectId = credentials.projectId;
  const appUrl = String(properties.getProperty('TODO_APP_URL') || '').replace(/\/+$/, '');
  const targetDate = String(notification.targetDate || '');
  const link = appUrl
    ? appUrl + '/?view=calendar' + (targetDate ? '&date=' + encodeURIComponent(targetDate) : '')
    : '';
  const message = {
    token: token,
    notification: {
      title: String(notification.title || 'TODO管理'),
      body: String(notification.body || '予定・メモを確認してください。')
    },
    data: {
      title: String(notification.title || 'TODO管理'),
      body: String(notification.body || ''),
      targetDate: targetDate,
      tag: String(notification.tag || 'todo-reminder')
    },
    webpush: {
      headers: { Urgency: 'high' },
      notification: {
        tag: String(notification.tag || 'todo-reminder'),
        renotify: true
      }
    }
  };
  if (appUrl) {
    message.webpush.notification.icon = appUrl + '/icon-192.png';
    message.webpush.notification.badge = appUrl + '/icon-192.png';
    message.webpush.fcm_options = { link: link };
  }

  const response = UrlFetchApp.fetch(
    'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(projectId) + '/messages:send',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + getFcmAccessToken_() },
      payload: JSON.stringify({ message: message }),
      muteHttpExceptions: true
    }
  );
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code >= 200 && code < 300) return true;
  if (body.indexOf('UNREGISTERED') >= 0 || body.indexOf('registration-token-not-registered') >= 0) {
    disablePushToken_(token);
  }
  throw new Error('FCM送信エラー(' + code + '): ' + body);
}

function todoDateKey_(todo) {
  const value = String(todo && todo.dueDate || '').trim();
  const match = value.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (match) {
    return match[1] + '-' + String(match[2]).padStart(2, '0') + '-' + String(match[3]).padStart(2, '0');
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, TODO_NOTIFICATION_TIMEZONE, 'yyyy-MM-dd');
}

function todoTimeLabel_(todo) {
  const value = String(todo && todo.dueDate || '');
  const match = value.match(/[T\s](\d{1,2}):(\d{2})/);
  if (!match) return '';
  return String(match[1]).padStart(2, '0') + ':' + match[2];
}

function buildPushBody_(items) {
  const lines = items.slice(0, 4).map(function (todo) {
    const time = todoTimeLabel_(todo);
    const prefix = todo.type === 'memo' ? '📝 ' : '・';
    return prefix + (time ? time + ' ' : '') + todo.title;
  });
  if (items.length > 4) lines.push('ほか' + (items.length - 4) + '件');
  return lines.join('\n');
}

function sendPushReminderForDate_(targetDateKey, slot) {
  if (!hasFcmServerConfig_()) return { sent: 0, reason: 'not-configured' };
  const todos = readTodos_().filter(function (todo) {
    return todo.status !== '完了' &&
      todo.pushNotify !== false &&
      todoDateKey_(todo) === targetDateKey;
  });
  if (!todos.length) return { sent: 0, reason: 'no-items' };
  const tokens = readPushTokens_();
  if (!tokens.length) return { sent: 0, reason: 'no-devices' };

  const title = slot === 'evening'
    ? '📅 明日の予定・メモがあります'
    : '🔔 今日の予定・メモ、お忘れではないですか？';
  const notification = {
    title: title,
    body: buildPushBody_(todos),
    targetDate: targetDateKey,
    tag: 'todo-' + slot + '-' + targetDateKey
  };
  let sent = 0;
  tokens.forEach(function (token) {
    try {
      if (sendFcmToToken_(token, notification)) sent += 1;
    } catch (error) {
      console.error('Push送信失敗:', error);
    }
  });
  return { sent: sent, itemCount: todos.length };
}

function sendMorningPushReminders() {
  const today = Utilities.formatDate(new Date(), TODO_NOTIFICATION_TIMEZONE, 'yyyy-MM-dd');
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('PUSH_LAST_morning') === today) return;
  const result = sendPushReminderForDate_(today, 'morning');
  if (result.sent > 0) properties.setProperty('PUSH_LAST_morning', today);
}

function sendEveningPushReminders() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowKey = Utilities.formatDate(tomorrow, TODO_NOTIFICATION_TIMEZONE, 'yyyy-MM-dd');
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('PUSH_LAST_evening') === tomorrowKey) return;
  const result = sendPushReminderForDate_(tomorrowKey, 'evening');
  if (result.sent > 0) properties.setProperty('PUSH_LAST_evening', tomorrowKey);
}

function setupPushNotificationTriggers() {
  const handlers = ['sendMorningPushReminders', 'sendEveningPushReminders'];
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('sendMorningPushReminders')
    .timeBased().atHour(8).nearMinute(0).everyDays(1).inTimezone(TODO_NOTIFICATION_TIMEZONE).create();
  ScriptApp.newTrigger('sendEveningPushReminders')
    .timeBased().atHour(19).nearMinute(0).everyDays(1).inTimezone(TODO_NOTIFICATION_TIMEZONE).create();
  return 'スマホ通知トリガーを作成しました（当日8時／前日19時・日本時間）。';
}

function testAllPushNotifications() {
  const today = Utilities.formatDate(new Date(), TODO_NOTIFICATION_TIMEZONE, 'yyyy-MM-dd');
  const tokens = readPushTokens_();
  tokens.forEach(function (token) {
    sendFcmToToken_(token, {
      title: '🔔 TODO管理 テスト通知',
      body: '通知設定は正常です。',
      targetDate: today,
      tag: 'todo-test-' + Date.now()
    });
  });
  return 'テスト通知送信: ' + tokens.length + '台';
}

/**
 * 任意：通知を使う場合のみ実行。
 * スクリプトプロパティ NOTIFY_EMAIL に送信先を設定し、
 * Apps Scriptのトリガーでこの関数を1時間ごとに実行してください。
 */
function sendTodoReminders() {
  const email = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  if (!email) return;

  const now = new Date();
  const todos = readTodos_();
  const userProperties = PropertiesService.getUserProperties();
  todos.forEach(function (todo) {
    if (!todo.mailNotify || todo.status === '完了' || !todo.dueDate) return;
    const due = new Date(todo.dueDate);
    if (isNaN(due.getTime())) return;
    const hours = (due.getTime() - now.getTime()) / 3600000;
    const windowName = hours > 47 && hours <= 49 ? '2days' : (hours > 2 && hours <= 4 ? '3hours' : '');
    if (!windowName) return;

    const sentKey = 'sent_' + todo.id + '_' + windowName + '_' + due.getTime();
    if (userProperties.getProperty(sentKey)) return;
    MailApp.sendEmail(email, '【TODO通知】' + todo.title,
      '期限が近づいています。\n\n' + todo.title + '\n期限: ' + todo.dueDate + '\n\n' + todo.description);
    userProperties.setProperty(sentKey, new Date().toISOString());
  });
}

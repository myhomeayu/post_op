// ==UserScript==
// @name         Post Operation - Auto Repost
// @namespace    https://github.com/myhomeayu/post_op
// @version      1.0.2
// @description  X(Twitter)のポストに「リポスト」が含まれていれば、通常リポストを実行する
// @author       myhomeayu
// @match        https://x.com/*/status/*
// @grant        none
// @downloadURL  https://github.com/myhomeayu/post_op/raw/main/post_op.user.js
// @updateURL    https://github.com/myhomeayu/post_op/raw/main/post_op.user.js
// ==/UserScript==

// ============================================================================
// 設定値（定数）
// ============================================================================

const CONFIG = {
  // デバッグログ: true で有効
  DEBUG_LOG: true,

  // ランダム遅延（ミリ秒）
  DELAY_MIN: 300,
  DELAY_MAX: 2000,

  // レート制限：直近N秒でM回まで
  RATE_LIMIT_WINDOW_SEC: 60,    // 60秒間
  RATE_LIMIT_MAX_EXECUTIONS: 3, // 最大3回

  // タイムアウト（要素待ち）
  WAIT_TIMEOUT_MS: 15000,

  // ポーリング間隔（要素検索）
  POLL_INTERVAL_MS: 100,

  // メニュー出現待機時間
  MENU_WAIT_TIMEOUT_MS: 5000,

  // 確定ボタン待機時間
  CONFIRM_WAIT_TIMEOUT_MS: 3000,
};

// ============================================================================
// アクション定義テーブル（将来拡張に対応）
// ============================================================================

const ACTIONS = {
  REPOST: {
    key: 'REPOST',
    keyword: 'リポスト',
    enabled: true,  // 今回は実行
    textPatterns: ['リポスト'],
    excludePatterns: ['引用'],
    label: '通常リポスト',
  },
  QUOTE: {
    key: 'QUOTE',
    keyword: '引用',
    enabled: false, // 将来実装（現時点は無効）
    textPatterns: ['引用する', '引用'],
    excludePatterns: [],
    label: '引用リポスト',
  },
};

// ============================================================================
// ユーティリティ
// ============================================================================

function log(...args) {
  if (CONFIG.DEBUG_LOG) {
    console.log('[post_op]', ...args);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay() {
  return Math.floor(Math.random() * (CONFIG.DELAY_MAX - CONFIG.DELAY_MIN + 1)) + CONFIG.DELAY_MIN;
}

function getCurrentStatusId() {
  const match = window.location.pathname.match(/\/status\/(\d+)$/);
  return match ? match[1] : null;
}

// ============================================================================
// レート制限
// ============================================================================

function initRateLimit() {
  const key = 'post_op_rate_limit_executions';
  if (!sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, JSON.stringify([]));
  }
}

function checkRateLimit() {
  const key = 'post_op_rate_limit_executions';
  const now = Date.now();
  let executions = JSON.parse(sessionStorage.getItem(key) || '[]');

  // 古いタイムスタンプを削除
  executions = executions.filter(
    ts => (now - ts) < CONFIG.RATE_LIMIT_WINDOW_SEC * 1000
  );

  const canExecute = executions.length < CONFIG.RATE_LIMIT_MAX_EXECUTIONS;

  if (canExecute) {
    executions.push(now);
    sessionStorage.setItem(key, JSON.stringify(executions));
    log(`レート制限: OK (${executions.length}/${CONFIG.RATE_LIMIT_MAX_EXECUTIONS})`);
  } else {
    log(`レート制限: NG (上限到達)`);
  }

  return canExecute;
}

// ============================================================================
// 多重実行防止
// ============================================================================

function isAlreadyProcessed(statusId) {
  const key = `post_op_processed_${statusId}`;
  return sessionStorage.getItem(key) === 'true';
}

function markAsProcessed(statusId) {
  const key = `post_op_processed_${statusId}`;
  sessionStorage.setItem(key, 'true');
  log(`[処理済み] statusId=${statusId} をマーク（成功確定）`);
}

function unmarkAsProcessed(statusId) {
  const key = `post_op_processed_${statusId}`;
  sessionStorage.removeItem(key);
  log(`[処理済み] statusId=${statusId} をアンマーク（失敗対応）`);
}

// ============================================================================
// ポスト本文抽出
// ============================================================================

function extractPostContent() {
  // 対象ポスト本文要素を取得
  // X（Twitter）では、ポストページの主要ポスト本文は特定のdata-testidを持つ
  const postContent = document.querySelector('[data-testid="tweetText"]');

  if (!postContent) {
    log('ポスト本文が見つかりません');
    return null;
  }

  let text = postContent.innerText || postContent.textContent || '';
  text = text.trim();

  // 正規化：過剰な空白・改行を削除
  text = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

  log('抽出本文:', text.substring(0, 100));
  return text;
}

// ============================================================================
// キーワード判定
// ============================================================================

function shouldExecuteAction(postContent) {
  if (!postContent) return null;

  // 有効なアクションを順に確認
  for (const actionKey in ACTIONS) {
    const action = ACTIONS[actionKey];
    if (!action.enabled) continue;

    // textPatterns マッチング
    let matched = false;
    for (const pattern of action.textPatterns) {
      if (postContent.includes(pattern)) {
        matched = true;
        break;
      }
    }

    if (!matched) continue;

    // excludePatterns チェック
    let excluded = false;
    for (const pattern of action.excludePatterns) {
      if (postContent.includes(pattern)) {
        excluded = true;
        break;
      }
    }

    if (excluded) {
      log(`判定結果: 「${action.keyword}」検出も除外パターンにより実行しない`);
      continue;
    }

    log(`判定結果: アクション「${action.label}」を実行`);
    return actionKey;
  }

  log('判定結果: 実行するアクションなし');
  return null;
}

// ============================================================================
// メニュー項目探索と実行
// ============================================================================

/**
 * メニュー要素内から対象アクション項目を探索
 * @param {Element} menuContainer - メニューコンテナ要素
 * @param {string} actionKey - REPOST / QUOTE など
 * @returns {Element|null} - 見つかった要素、またはnull
 */
function findMenuItemInContainer(menuContainer, actionKey) {
  if (!menuContainer) return null;

  const action = ACTIONS[actionKey];
  if (!action) return null;

  // 候補セレクタ（優先順位）
  const candidates = [];

  // 1. data-testid で探索（最優先）
  const testIdSelectors = [
    `[data-testid*="${actionKey.toLowerCase()}"]`,
    `[data-testid*="retweet"]`, // REPOST の場合
  ];
  for (const selector of testIdSelectors) {
    const elem = menuContainer.querySelector(selector);
    if (elem) {
      log(`[メニュー探索] data-testid マッチ: ${selector}`);
      candidates.push({ elem, reason: 'data-testid' });
    }
  }

  // 2. role ベース（menuitem など）
  if (candidates.length === 0) {
    const roleElements = menuContainer.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button');
    for (const elem of roleElements) {
      candidates.push({ elem, reason: 'role-based' });
    }
  }

  // 3. テキストマッチング
  if (candidates.length === 0) {
    const allClickable = menuContainer.querySelectorAll('button, [role="menuitem"], [role="button"], a, div[tabindex]');
    for (const elem of allClickable) {
      const text = elem.innerText || elem.textContent || '';
      // textPatterns にマッチしたら候補に追加
      for (const pattern of action.textPatterns) {
        if (text.includes(pattern)) {
          candidates.push({ elem, reason: 'text-match', pattern });
          break;
        }
      }
    }
  }

  // 候補から最適なものを選択（テキスト一致優先）
  for (const candidate of candidates) {
    const elem = candidate.elem;
    const text = elem.innerText || elem.textContent || '';

    // excludePatterns チェック
    let isValid = true;
    for (const excludePattern of action.excludePatterns) {
      if (text.includes(excludePattern)) {
        isValid = false;
        log(`[メニュー探索] 除外: "${text}" (含む: "${excludePattern}")`);
        break;
      }
    }

    if (isValid && text.trim().length > 0) {
      log(`[メニュー探索] 決定: "${text}" (方式: ${candidate.reason})`);
      return elem;
    }
  }

  log('[メニュー探索] 該当要素が見つかりません');
  return null;
}

/**
 * アクション実行（メニュー選択 → 確定ボタンまで）
 * @param {string} actionKey - REPOST / QUOTE など
 * @param {string} statusId - ポストID（処理済みマークで使用）
 * @returns {Promise<boolean>}
 */
async function executeAction(actionKey, statusId) {
  const action = ACTIONS[actionKey];
  if (!action || !action.enabled) {
    log(`[実行] アクション「${actionKey}」は無効または存在しません`);
    return false;
  }

  log(`[実行] アクション「${action.label}」の実行開始`);

  // ランダム遅延
  const delay = getRandomDelay();
  log(`[実行] ランダム遅延: ${delay}ms`);
  await sleep(delay);

  // メニュー出現を待機
  const menuContainer = await waitForElement('[role="menu"], div[role="dialog"]', CONFIG.MENU_WAIT_TIMEOUT_MS);
  if (!menuContainer) {
    log('[実行] メニューが出現しません（タイムアウト）');
    return false;
  }

  log('[実行] メニューを検出');

  // メニュー内から対象アクション項目を探索
  const menuItem = findMenuItemInContainer(menuContainer, actionKey);
  if (!menuItem) {
    log(`[実行] メニュー内に「${action.label}」項目が見つかりません`);
    return false;
  }

  // クリック前に無効状態をチェック
  if (menuItem.disabled || menuItem.getAttribute('aria-disabled') === 'true') {
    log(`[実行] メニュー項目が無効状態です`);
    return false;
  }

  // 視界に入れる
  try {
    menuItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    log(`[実行] scrollIntoView 失敗: ${e.message}`);
  }

  // クリック実行
  log(`[実行] メニュー項目をクリック`);
  await sleep(getRandomDelay());

  try {
    menuItem.click();
  } catch (e) {
    log(`[実行] click() 失敗: ${e.message}、MouseEvent フォールバック試行`);
    const mouseEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    try {
      menuItem.dispatchEvent(mouseEvent);
    } catch (e2) {
      log(`[実行] MouseEvent 失敗: ${e2.message}`);
      return false;
    }
  }

  // 確定ボタン待機（2段階確定対応）
  await sleep(500);
  const confirmButton = await findConfirmButton(action.label, CONFIG.CONFIRM_WAIT_TIMEOUT_MS);

  if (confirmButton) {
    log(`[実行] 確定ボタン検出`);
    await sleep(getRandomDelay());

    if (confirmButton.disabled || confirmButton.getAttribute('aria-disabled') === 'true') {
      log(`[実行] 確定ボタンが無効状態です`);
      return false;
    }

    try {
      confirmButton.click();
      log(`[実行] 確定ボタンクリック`);
    } catch (e) {
      log(`[実行] 確定クリック失敗: ${e.message}`);
      return false;
    }
  } else {
    log(`[実行] 確定ボタンなし（メニュー選択のみで完了）`);
    // 確定ボタンが不要な場合、ここで処理済みをマーク
    if (statusId) {
      markAsProcessed(statusId);
    }
  }

  log(`[実行] アクション「${action.label}」完了`);
  // 確定ボタンがあって成功した場合、ここで処理済みをマーク
  if (confirmButton && statusId) {
    markAsProcessed(statusId);
  }
  return true;
}

/**
 * 確定ボタンを探索（data-testid → role → テキストの優先順位）
 * @param {string} actionLabel - アクション名
 * @param {number} timeoutMs - タイムアウト
 * @returns {Promise<Element|null>}
 */
async function findConfirmButton(actionLabel, timeoutMs) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // data-testid で探索
    let button = document.querySelector('[data-testid="confirmButton"]') ||
                 document.querySelector('[data-testid*="confirm"]');
    if (button) {
      log(`[確定ボタン] data-testid マッチ`);
      return button;
    }

    // role で探索
    button = document.querySelector('[role="button"][aria-label*="確定"]') ||
             document.querySelector('button[aria-label*="確定"]');
    if (button) {
      log(`[確定ボタン] role/aria-label マッチ`);
      return button;
    }

    // テキストマッチング
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.innerText || btn.textContent || '';
      if ((text.includes('確定') || text.includes('リポスト')) && !text.includes('キャンセル')) {
        if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
          log(`[確定ボタン] テキストマッチ: "${text}"`);
          return btn;
        }
      }
    }

    await sleep(CONFIG.POLL_INTERVAL_MS);
  }

  log(`[確定ボタン] 見つかりません（タイムアウト）`);
  return null;
}

// ============================================================================
// ボタンクリック・要素探索ユーティリティ
// ============================================================================

async function waitForElement(selector, timeoutMs) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }

  return null;
}

/**
 * リポストボタン（初期トリガー）を探索・クリック
 * @returns {Promise<boolean>}
 */
async function clickRepostButton() {
  const repostButton = document.querySelector('[aria-label*="リポスト"]') ||
                       document.querySelector('[aria-label*="Retweet"]') ||
                       document.querySelector('[data-testid="retweet"]');

  if (!repostButton) {
    log('[初期] リポストボタンが見つかりません');
    return false;
  }

  log('[初期] リポストボタンを検出');

  // ランダム遅延
  const delay = getRandomDelay();
  log(`[初期] ランダム遅延: ${delay}ms`);
  await sleep(delay);

  // ボタンをクリック
  try {
    repostButton.click();
    log('[初期] リポストボタンをクリック');
    return true;
  } catch (e) {
    log(`[初期] クリック失敗: ${e.message}`);
    return false;
  }
}

// ============================================================================
// メイン処理
// ============================================================================

async function processPost() {
  const statusId = getCurrentStatusId();

  if (!statusId) {
    log('ステータスIDが取得できません');
    return;
  }

  log(`ステータスID: ${statusId}`);

  // 多重実行防止：既に処理済みかチェック
  if (isAlreadyProcessed(statusId)) {
    log('[スキップ] 既に処理済みポスト');
    return;
  }

  // レート制限チェック
  if (!checkRateLimit()) {
    log('スキップ: レート制限');
    return;
  }

  // ポスト本文抽出
  const postContent = extractPostContent();
  if (!postContent) {
    log('スキップ: ポスト本文取得失敗');
    return;
  }

  // 実行するアクション判定
  const actionKey = shouldExecuteAction(postContent);
  if (!actionKey) {
    log('スキップ: 実行するアクションなし');
    return;
  }

  // リポスト処理：try/finallyで失敗時の自動解除を保証
  try {
    log('[実行] リポスト処理開始');
    const buttonClicked = await clickRepostButton();
    if (!buttonClicked) {
      log('[失敗] リポストボタンクリック失敗');
      return;
    }

    // アクション実行（メニュー選択 → 確定ボタンまで）
    const success = await executeAction(actionKey, statusId);

    if (success) {
      log('[完了] リポスト完了（処理済みをマーク）');
      // ※ executeAction() 内で markAsProcessed() 呼び出し済み
    } else {
      log('[失敗] アクション実行失敗（自動解除を実行）');
      unmarkAsProcessed(statusId);
    }
  } catch (e) {
    log(`[エラー] 予期しないエラー: ${e.message}（自動解除を実行）`);
    unmarkAsProcessed(statusId);
  }
}

// ============================================================================
// SPA対応: イベント監視
// ============================================================================

function initMutationObserver() {
  // ポスト本文DOが出現したことを検知
  let processingInProgress = false;
  const observer = new MutationObserver((mutations) => {
    // 既に処理中なら返す
    if (processingInProgress) return;
    
    for (const mutation of mutations) {
      if (mutation.type === 'childList' || mutation.type === 'subtree') {
        const tweetText = document.querySelector('[data-testid="tweetText"]');
        if (tweetText) {
          // ポスト本文が表示された
          const statusId = getCurrentStatusId();
          if (statusId && !isAlreadyProcessed(statusId)) {
            log('MutationObserver: ポスト本文検出');
            processingInProgress = true;
            processPost().catch(e => {
              log('処理中エラー:', e.message);
            }).finally(() => {
              processingInProgress = false;
            });
          }
          break;
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return observer;
}

function initHistoryHook() {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(history, args);
    log('history.pushState 検出');
    setTimeout(() => {
      processPost().catch(e => {
        log('処理中エラー:', e.message);
      });
    }, 500);
    return undefined;
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(history, args);
    log('history.replaceState 検出');
    setTimeout(() => {
      processPost().catch(e => {
        log('処理中エラー:', e.message);
      });
    }, 500);
    return undefined;
  };
}

// ============================================================================
// 初期化
// ============================================================================

function init() {
  log('スクリプト開始');
  log('現在のURL:', window.location.href);

  // 初期化
  initRateLimit();

  // 監視開始
  initMutationObserver();
  initHistoryHook();

  // 初回処理（ページ読み込み後）
  setTimeout(() => {
    processPost().catch(e => {
      log('初期処理中エラー:', e.message);
    });
  }, 1000);
}

// ============================================================================
// デバッグ・管理コマンド
// ============================================================================

/**
 * 指定ポストの処理済みフラグを解除
 * @param {string} statusId - ポストID
 */
function clearProcessedFlag(statusId) {
  if (!statusId) {
    statusId = getCurrentStatusId();
  }
  if (statusId) {
    unmarkAsProcessed(statusId);
    alert(`ポスト ${statusId} の処理済みフラグを解除しました`);
  }
}

/**
 * 全ての処理済みフラグをクリア
 */
function clearAllProcessedFlags() {
  const keysToRemove = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith('post_op_processed_')) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach(key => {
    sessionStorage.removeItem(key);
    const statusId = key.replace('post_op_processed_', '');
    log(`[管理] 処理済みクリア: ${statusId}`);
  });

  alert(`${keysToRemove.length} 件の処理済みフラグをクリアしました`);
}

// スクリプト開始
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ==UserScript==
// @name         Post Operation - Auto Repost
// @namespace    https://github.com/myhomeayu/post_op
// @version      1.0.0
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

function shouldRepost(postContent) {
  if (!postContent) return false;

  // 「リポスト」キーワードを検索
  const keyword = 'リポスト';
  const found = postContent.includes(keyword);

  log(`判定結果: 「${keyword}」 ${found ? '検出' : '未検出'}`);

  return found;
}

// ============================================================================
// リポストボタン検索・クリック
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

async function findAndClickRepostButton() {
  // リポストボタンをdata-testidで検索
  // X（Twitter）のリポストボタンは data-testid="retweet" のようなIDを持つ
  const repostButton = document.querySelector('[aria-label*="リポスト"]') ||
                       document.querySelector('[aria-label*="Retweet"]') ||
                       document.querySelector('[data-testid="retweet"]');

  if (!repostButton) {
    log('リポストボタンが見つかりません');
    return false;
  }

  log('リポストボタンを検出');

  // ランダム遅延
  const delay = getRandomDelay();
  log(`ランダム遅延: ${delay}ms`);
  await sleep(delay);

  // ボタンをクリック
  try {
    repostButton.click();
    log('リポストボタンをクリック');
  } catch (e) {
    log('クリック失敗:', e.message);
    return false;
  }

  // メニューが出現する場合の対応
  await sleep(500);

  // 引用ではない「リポスト」を選択
  const repostMenuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
  let repostMenuItem = null;

  for (const item of repostMenuItems) {
    const text = item.innerText || item.textContent || '';
    // 「リポスト」単体で、「引用」を含まないもの
    if (text.includes('リポスト') && !text.includes('引用')) {
      repostMenuItem = item;
      break;
    }
  }

  if (repostMenuItem) {
    log('リポストメニュー選択');
    await sleep(getRandomDelay());
    try {
      repostMenuItem.click();
    } catch (e) {
      log('メニュークリック失敗:', e.message);
      return false;
    }
  } else {
    // メニューが出ない場合、そのまま完了と判定
    log('メニューなし（直接実行）');
  }

  // 確認ダイアログ対応（タイムアウト付き）
  const confirmButton = await waitForElement(
    'button[aria-label*="リポスト"], button[aria-label*="Retweet"]',
    3000
  );

  if (confirmButton) {
    log('確認ボタン検出');
    await sleep(getRandomDelay());
    try {
      confirmButton.click();
      log('確認ボタンクリック');
    } catch (e) {
      log('確認クリック失敗:', e.message);
      return false;
    }
  }

  return true;
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

  // 多重実行防止：早期にフラグを立てる
  if (isAlreadyProcessed(statusId)) {
    log('スキップ: 既に処理済み');
    return;
  }
  markAsProcessed(statusId);

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

  // キーワード判定
  if (!shouldRepost(postContent)) {
    log('スキップ: キーワード未検出');
    return;
  }

  // リポスト実行
  log('リポスト実行開始');
  const success = await findAndClickRepostButton();

  if (success) {
    log('リポスト完了');
  } else {
    log('リポスト失敗');
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

// スクリプト開始
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

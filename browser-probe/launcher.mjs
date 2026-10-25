// User clicks the extension on Zhixue; activeTab grants access to that tab only.
chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !tab.url) return;
  let allowed = false;
  try { allowed = new URL(tab.url).origin === 'https://www.zhixue.com'; } catch { /* unsupported tab */ }
  const url = new URL(chrome.runtime.getURL('popup.html'));
  if (allowed) url.searchParams.set('sourceTab', String(tab.id));
  await chrome.tabs.create({url:url.href});
});

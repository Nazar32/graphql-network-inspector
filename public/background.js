chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === "install") {
    chrome.tabs.create({ url: "https://www.overstacked.io/?install=true" })
  }
})

// Print diagnostic lines sent by the devtools panel. Open this console from
// chrome://extensions with the "service worker" link under this extension.
chrome.runtime.onMessage.addListener(function (message) {
  if (message && message.__gniDiagnostic) {
    console.log("[GNI]", message.event, message.data === undefined ? "" : message.data)
  }
})

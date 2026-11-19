// Exchange endpoints Apostille accepts. Append-only on-chain: a source's index is its id.
// To add an exchange, capture its fee/VIP endpoint in the Primus Developer Hub, then call
// addSource() with the endpoint and the json paths of the four fields.
module.exports = [
  {
    name: "Binance",
    url: "https://www.binance.com/bapi/accounts/v1/private/vip/vip-portal/vip-fee/vip-fee-summary",
    idPath: "$.data.userId",
    vipPath: "$.data.vipLevel",
    spotPath: "$.data.spot30dVol",
    futuresPath: "$.data.futures30dVol",
    enabled: true,
    // Primus Developer Hub template that captures this endpoint.
    templateId: "9e2dff87-3bfd-4a65-ad84-9eeb87d0f56e",
  },
];

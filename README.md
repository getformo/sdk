<p align="center">
	<h1 align="center"><b>Formo Web SDK</b></h1>
<p align="center">
    Unified analytics for onchain apps.
    <br />
    <a href="https://formo.so">Website</a>
    ·
    <a href="https://docs.formo.so">Docs</a>
    ·
    <a href="https://app.formo.so">Dashboard</a>
    ·
    <a href="https://formo.so/slack">Slack</a>
    ·
    <a href="https://twitter.com/getformo">X</a>
  </p>
</p>

## Installation

The Formo Web SDK is a Javascript library that allows you to track user event data from your website and app.

You can install Formo on:
- [Wagmi](https://docs.formo.so/install#wagmi) (recommended)
- [HTML Snippet](https://docs.formo.so/install#html-snippet)
- [React](https://docs.formo.so/install#react)
- [Next.js](https://docs.formo.so/install#next-js)

## Configuration

Visit Formo's [Developer Docs](https://docs.formo.so) for detailed guides on local testing, debugging, and consent management.

### Idempotency for custom events

The SDK deduplicates custom events in two ways.

**Automatically, for 60 seconds.** When `track()` is called twice with the same
event name and properties within 60 seconds, the SDK sends the event once.
This handles accidental double-fires, such as a React effect that runs twice.
It applies within one page session.

**With an idempotency key, for retries.** For business-critical events, add
the reserved `idempotency_key` property with a stable identifier for the
occurrence, such as an order ID. Every call that reuses the key for the same
event name gets the same message ID, so ingestion keeps one event however many
times it is sent, including across reloads:

```ts
await formo.track("Order Placed", {
  market: "ETH-USDC",
  side: "buy",
  volume: 2500,
  idempotency_key: order.id,
});
```

Use a unique key for each real occurrence. The key is hashed into the message
ID and is not sent as a property. Strings and finite numbers are accepted; any
other value is rejected with a warning and the event is not sent. A call the
SDK recognises as a duplicate does not invoke its callback. Server-side
deduplication applies within one ingestion session and one storage partition.

Using [Privy](./docs/PRIVY_INTEGRATION.md)? `identify(user)`
clusters all of a Privy user's linked wallets under a single identity.

## Methodology

Learn how Formo handles [onchain attribution](https://docs.formo.so/data/attribution) and [data collection](https://docs.formo.so/data/what-we-collect).

## Support

Join the [Formo community Slack channel](https://formo.so/slack) for help and questions.

## Contributing

[Contributions](https://github.com/getformo/sdk/blob/main/CONTRIBUTING.md) are welcome! Feel free to open fixes and feature suggestions.

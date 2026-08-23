# Browser harness

A real browser running the real built bundle, against wallets that announce
themselves over **EIP-6963** exactly as extensions do. No `window.ethereum`.

```
anvil --port 8545 --chain-id 31337 &   # a local chain, so receipts are genuine
npm run build
npm run test:browser
```

It adds **no dependencies**: the runner drives headless Chrome over the
DevTools protocol with Node's built-in `WebSocket`, and the harness page is
plain HTML.

## Why it exists

The unit suite and the Node harness both run under Node. They cannot see a
class of bug that only exists in a browser. The first one found was
`personal_sign` capture decoding with `Buffer`, a Node global with no polyfill
in the bundle: in every real browser that threw and the signature event was
dropped, silently, and it was caught by a reviewer rather than a test.

Reintroducing that bug makes three checks here fail with `[]`. That is the
bar for anything added to this harness: it must fail for a bug the other
suites would pass.

## What it checks

Every step asserts the **exact** event list, not "something was sent", because
a missing or duplicated event is the shape of every bug in this area:
discovery over 6963, connect, signature (confirmed and user-rejected), chain
switch, a transaction with a real receipt, an EIP-5792 batch, a wallet switch
between two providers, and disconnect. It also asserts the SDK issued no RPC
on a wallet's transport beyond `eth_accounts` and the receipt/status polls.

## What it does not do

It does not drive a real wallet extension. The wallets here speak the same
protocol but sign nothing; the harness holds no key and cannot be pointed at a
real chain by accident. Real-extension coverage (MetaMask's own prompt
behaviour, such as #356) belongs in a separate, heavier harness outside this
repo, against the published package.

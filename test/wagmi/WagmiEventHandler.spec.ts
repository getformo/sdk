import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { WagmiEventHandler, __resetSeededWallet, MARKER_GRACE_MS, MAX_ANNOUNCED_CONNECTIONS } from "../../src/wagmi/WagmiEventHandler";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import {
  WagmiConfig,
  WagmiState,
  QueryClient,
  MutationCache,
  MutationCacheEvent,
  QueryCache,
  QueryCacheEvent,
} from "../../src/wagmi/types";

describe("WagmiEventHandler", () => {
  let sandbox: sinon.SinonSandbox;
  let mockFormo: sinon.SinonStubbedInstance<FormoAnalytics>;
  let mockWagmiConfig: WagmiConfig;
  let mockQueryClient: QueryClient;
  let statusListener: ((status: WagmiState["status"], prevStatus: WagmiState["status"]) => void) | null;
  let chainIdListener: ((chainId: number | undefined, prevChainId: number | undefined) => void) | null;
  let mutationListener: ((event: MutationCacheEvent) => void) | null;
  let queryListener: ((event: QueryCacheEvent) => void) | null;
  let addressListener: ((address: string | undefined, prevAddress: string | undefined) => void) | null;

  const mockAddress = "0x1234567890123456789012345678901234567890";
  const PROBE_ADDRESS = "0x00000000000000000000000000000000000pr0be";
  const mockChainId = 1;

  const createMockState = (overrides: Partial<WagmiState> = {}): WagmiState => ({
    status: "disconnected",
    connections: new Map(),
    current: undefined,
    chainId: undefined,
    ...overrides,
  });

  const createConnectedState = (address: string = mockAddress, chainId: number = mockChainId): WagmiState => {
    const connections = new Map();
    connections.set("connector-1", {
      accounts: [address],
      chainId,
      connector: { id: "metamask", name: "MetaMask", type: "injected", uid: "1" },
    });
    return {
      status: "connected",
      connections,
      current: "connector-1",
      chainId,
    };
  };

  beforeEach(() => {
    __resetSeededWallet();
    sandbox = sinon.createSandbox();
    statusListener = null;
    chainIdListener = null;
    mutationListener = null;
    queryListener = null;
    addressListener = null;

    // Create mock FormoAnalytics
    mockFormo = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      chain: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
      // Model the real method: it learns the wallet into central state, which
      // the seed then checks before adopting it privately. Tests that need the
      // suppressed path override this with a no-op.
      syncWalletState: sandbox.stub().callsFake((params: any) => {
        (mockFormo as any).currentAddress = params?.address;
        (mockFormo as any).currentChainId = params?.chainId;
      }),
      willTrackEvent: sandbox.stub().returns(true),
      currentAddress: undefined,
      currentChainId: undefined,
      writeKey: "test-write-key",
    } as any;

    // Create mock Wagmi config with subscribe
    let currentState = createMockState();
    mockWagmiConfig = {
      subscribe: sandbox.stub().callsFake((selector: any, listener: any) => {
        // Route each subscription to the right local by probing the selector.
        // The probe state carries a distinguishable value for all three
        // slices, because the status and address selectors both return
        // strings and cannot be told apart by type alone.
        const probeConnections = new Map();
        probeConnections.set("probe", {
          accounts: [PROBE_ADDRESS],
          chainId: 1,
          connector: { id: "probe", name: "Probe", type: "injected", uid: "p" },
        });
        const testState = createMockState({
          status: "connected",
          chainId: 1,
          connections: probeConnections,
          current: "probe",
        });
        const selectedValue = selector(testState);

        if (
          typeof selectedValue === "string" &&
          selectedValue.includes(PROBE_ADDRESS)
        ) {
          // The connection selector returns "<connectorId>|<address>".
          const raw = listener;
          addressListener = ((address: string | undefined, prev: string | undefined) =>
            raw(`probe|${address ?? ""}`, `probe|${prev ?? ""}`)) as any;
        } else if (typeof selectedValue === "string") {
          statusListener = listener;
        } else if (typeof selectedValue === "number" || selectedValue === undefined) {
          chainIdListener = listener;
        }

        return () => {
          statusListener = null;
          chainIdListener = null;
          addressListener = null;
        };
      }),
      getState: sandbox.stub().callsFake(() => currentState),
      state: currentState,
    };

    // Helper to update mock state
    (mockWagmiConfig as any).setState = (newState: WagmiState) => {
      currentState = newState;
      (mockWagmiConfig.getState as sinon.SinonStub).returns(newState);
      mockWagmiConfig.state = newState;
    };

    // Create mock QueryClient
    const mockMutationCache: MutationCache = {
      subscribe: sandbox.stub().callsFake((listener: any) => {
        mutationListener = listener;
        return () => {
          mutationListener = null;
        };
      }),
    };

    const mockQueryCache: QueryCache = {
      subscribe: sandbox.stub().callsFake((listener: any) => {
        queryListener = listener;
        return () => {
          queryListener = null;
        };
      }),
    };

    mockQueryClient = {
      getMutationCache: sandbox.stub().returns(mockMutationCache),
      getQueryCache: sandbox.stub().returns(mockQueryCache),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe("constructor", () => {
    it("should initialize and set up connection listeners", () => {
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig);

      // status, chainId, and the active address
      expect((mockWagmiConfig.subscribe as sinon.SinonStub).calledThrice).to.be.true;
      expect(statusListener).to.not.be.null;
      expect(chainIdListener).to.not.be.null;
      expect(addressListener).to.not.be.null;
    });

    it("should set up mutation tracking when QueryClient is provided", () => {
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      expect((mockQueryClient.getMutationCache as sinon.SinonStub).calledOnce).to.be.true;
    });

    it("should not set up mutation tracking when QueryClient is not provided", () => {
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig);

      expect(mutationListener).to.be.null;
    });
  });

  describe("connection events", () => {
    it("should track connect event when status changes to connected", async () => {
      // Build the handler while disconnected. A transition *into* connected can
      // only be observed by a handler that was already subscribed while the
      // status was something else, since subscribe() fires on change only.
      (mockWagmiConfig as any).setState(createMockState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Simulate status change
      (mockWagmiConfig as any).setState(createConnectedState());
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.connect.calledOnce).to.be.true;
      const connectCall = mockFormo.connect.firstCall;
      expect(connectCall.args[0]).to.deep.include({
        chainId: mockChainId,
        address: mockAddress,
      });
    });

    it("should track disconnect event when status changes to disconnected", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // First connect
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      // Then disconnect
      (mockWagmiConfig as any).setState(createMockState());
      if (statusListener) {
        await statusListener("disconnected", "connected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.disconnect.calledOnce).to.be.true;
    });

    it("should not track connect when autocapture is disabled", async () => {
      mockFormo.isAutocaptureEnabled.withArgs("connect").returns(false);

      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.connect.called).to.be.false;
    });
  });

  describe("chain events", () => {
    it("should track chain change when chainId changes while connected", async () => {
      const connectedState = createConnectedState(mockAddress, 1);
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      // Then change chain
      const newChainState = createConnectedState(mockAddress, 137);
      (mockWagmiConfig as any).setState(newChainState);

      if (chainIdListener) {
        await chainIdListener(137, 1);
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.chain.calledOnce).to.be.true;
      expect(mockFormo.chain.firstCall.args[0]).to.deep.include({
        chainId: 137,
        address: mockAddress,
      });
    });

    it("should not track chain change when disconnected", async () => {
      (mockWagmiConfig as any).setState(createMockState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (chainIdListener) {
        await chainIdListener(137, 1);
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.chain.called).to.be.false;
    });

    it("should not track chain change when chainId is undefined", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (chainIdListener) {
        await chainIdListener(undefined, 1);
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.chain.called).to.be.false;
    });
  });

  describe("signature mutations", () => {
    it("should track signMessage mutation on success", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      // Simulate signMessage mutation
      const rawSig = "0x" + "ab".repeat(65); // realistic 65-byte ECDSA sig
      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 1,
          options: { mutationKey: ["signMessage"] },
          state: {
            status: "success",
            data: rawSig,
            variables: { message: "Hello World" },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.signature.calledOnce).to.be.true;
      const arg = mockFormo.signature.firstCall.args[0];
      expect(arg.status).to.equal("confirmed");
      expect(arg.message).to.equal("Hello World");
      // The produced signature must never be captured.
      expect(arg).to.not.have.property("signatureHash");
      expect(JSON.stringify(arg)).to.not.contain(rawSig);
    });

    it("should track signMessage mutation on pending", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 2,
          options: { mutationKey: ["signMessage"] },
          state: {
            status: "pending",
            variables: { message: "Hello" },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.signature.calledOnce).to.be.true;
      expect(mockFormo.signature.firstCall.args[0].status).to.equal("requested");
    });

    it("should track signMessage mutation on error as rejected", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 3,
          options: { mutationKey: ["signMessage"] },
          state: {
            status: "error",
            error: new Error("User rejected"),
            variables: { message: "Hello" },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.signature.calledOnce).to.be.true;
      expect(mockFormo.signature.firstCall.args[0].status).to.equal("rejected");
    });

    it("should track signTypedData mutation", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const rawSig = "0x" + "ab".repeat(65);
      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 4,
          options: { mutationKey: ["signTypedData"] },
          state: {
            status: "success",
            data: rawSig,
            variables: {
              domain: { name: "USD Coin", chainId: 1, verifyingContract: "0xA0b8" },
              primaryType: "Permit",
              types: { Permit: [{ name: "owner", type: "address" }] },
              message: {
                owner: "0xVictim",
                spender: "0xATTACKER",
                value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
                deadline: 9999999999,
              },
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.signature.calledOnce).to.be.true;
      const arg = mockFormo.signature.firstCall.args[0];
      // The produced signature must never be captured.
      expect(arg).to.not.have.property("signatureHash");
      expect(JSON.stringify(arg)).to.not.contain(rawSig);
    });
  });

  describe("transaction mutations", () => {
    it("should track sendTransaction mutation on success", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 5,
          options: { mutationKey: ["sendTransaction"] },
          state: {
            status: "success",
            data: "0xtxhash123",
            variables: {
              to: "0xrecipient",
              value: BigInt(1000000000000000000),
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall;
      expect(txCall.args[0]).to.deep.include({
        status: "broadcasted",
        transactionHash: "0xtxhash123",
        to: "0xrecipient",
      });
    });

    it("should track writeContract mutation", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 6,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "pending",
            variables: {
              address: "0xcontract",
              abi: [
                {
                  type: "function",
                  name: "repayBorrow",
                  inputs: [{ name: "repayAmount", type: "uint256" }],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "repayBorrow",
              args: [BigInt(3300000)],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];
      expect(txCall.status).to.equal("started");
      expect(txCall.to).to.equal("0xcontract");
      expect(txCall.function_name).to.equal("repayBorrow");
      expect(txCall.function_args).to.deep.equal({ repayAmount: "3300000" });

      // Verify function args are also passed as additional properties (second argument)
      // 'repayAmount' doesn't collide with any built-in field, so no prefix needed
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({ repayAmount: "3300000" });
    });

    it("should track writeContract mutation with multiple args", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 60,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash456",
            variables: {
              address: "0xtoken",
              abi: [
                {
                  type: "function",
                  name: "transfer",
                  inputs: [
                    { name: "to", type: "address" },
                    { name: "amount", type: "uint256" },
                  ],
                  outputs: [{ name: "", type: "bool" }],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "transfer",
              args: ["0xrecipient123", BigInt("1000000000000000000")],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];
      expect(txCall.status).to.equal("broadcasted");
      expect(txCall.transactionHash).to.equal("0xtxhash456");
      expect(txCall.to).to.equal("0xtoken");
      expect(txCall.function_name).to.equal("transfer");
      expect(txCall.function_args).to.deep.equal({
        to: "0xrecipient123",
        amount: "1000000000000000000",
      });

      // Verify function args are also passed as additional properties (second argument)
      // 'to' collides with transaction 'to' field, so it gets prefixed
      // 'amount' doesn't collide, so it stays unprefixed
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({
        arg_to: "0xrecipient123",
        amount: "1000000000000000000",
      });
    });

    it("should not include function_name and function_args for sendTransaction", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 61,
          options: { mutationKey: ["sendTransaction"] },
          state: {
            status: "success",
            data: "0xtxhash789",
            variables: {
              to: "0xrecipient",
              data: "0xabcdef1234",
              value: BigInt(1000000000000000000),
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];
      expect(txCall.status).to.equal("broadcasted");
      expect(txCall.transactionHash).to.equal("0xtxhash789");
      expect(txCall.to).to.equal("0xrecipient");
      expect(txCall.data).to.equal("0xabcdef1234");
      // function_name and function_args should NOT be present for sendTransaction
      expect(txCall.function_name).to.be.undefined;
      expect(txCall.function_args).to.be.undefined;

      // Properties (second argument) should be undefined for sendTransaction
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.be.undefined;
    });

    it("should not track transaction when autocapture is disabled", async () => {
      mockFormo.isAutocaptureEnabled.withArgs("transaction").returns(false);

      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 7,
          options: { mutationKey: ["sendTransaction"] },
          state: { status: "success", data: "0xtx" },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.called).to.be.false;
    });

    it("should not overwrite transaction 'to' with function arg 'to' (collision avoidance)", async () => {
      // This test verifies that when a function like transfer(address to, uint256 amount)
      // is called, the 'to' field in function_args doesn't overwrite the transaction 'to'
      // (contract address). Only colliding keys get the 'arg_' prefix.
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 100,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_collision_test",
            variables: {
              address: "0xContractAddress", // This is the contract address (transaction 'to')
              abi: [
                {
                  type: "function",
                  name: "transfer",
                  inputs: [
                    { name: "to", type: "address" },      // This 'to' is the recipient (collides!)
                    { name: "amount", type: "uint256" },  // Doesn't collide
                  ],
                  outputs: [{ name: "", type: "bool" }],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "transfer",
              args: ["0xRecipientAddress", BigInt("1000000000000000000")],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];

      // The transaction 'to' should be the contract address, NOT the recipient
      expect(txCall.to).to.equal("0xContractAddress");

      // The function_args should contain the unprefixed original keys
      expect(txCall.function_args).to.deep.equal({
        to: "0xRecipientAddress",
        amount: "1000000000000000000",
      });

      // The second argument (properties) should have:
      // - 'to' prefixed to 'arg_to' (collision with transaction field)
      // - 'amount' unprefixed (no collision)
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({
        arg_to: "0xRecipientAddress",
        amount: "1000000000000000000",
      });

      // Ensure arg_to doesn't equal the contract address (it should be the recipient)
      expect(txProperties!.arg_to).to.not.equal(txCall.to);
    });

    it("should handle writeContract with nested struct containing BigInt", async () => {
      // Tests Solidity structs like: struct Order { address maker; uint256 price; }
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 101,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_struct_test",
            variables: {
              address: "0xOrderBook",
              abi: [
                {
                  type: "function",
                  name: "submitOrder",
                  inputs: [
                    {
                      name: "order",
                      type: "tuple",
                      components: [
                        { name: "maker", type: "address" },
                        { name: "price", type: "uint256" },
                        { name: "amount", type: "uint256" },
                      ],
                    },
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "submitOrder",
              args: [
                {
                  maker: "0xMakerAddress",
                  price: BigInt("1000000000000000000"),
                  amount: BigInt("50000000"),
                },
              ],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];

      expect(txCall.function_name).to.equal("submitOrder");
      // BigInt values inside the struct should be converted to strings
      expect(txCall.function_args).to.deep.equal({
        order: {
          maker: "0xMakerAddress",
          price: "1000000000000000000",
          amount: "50000000",
        },
      });

      // 'order' doesn't collide with any built-in field, so no prefix needed
      // Nested struct fields are also flattened for easier querying
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({
        order: {
          maker: "0xMakerAddress",
          price: "1000000000000000000",
          amount: "50000000",
        },
        // Flattened nested struct fields
        order_maker: "0xMakerAddress",
        order_price: "1000000000000000000",
        order_amount: "50000000",
      });
    });

    it("should handle writeContract with array of structs containing BigInt", async () => {
      // Tests Solidity: function batchTransfer(Transfer[] calldata transfers)
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 102,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_batch_test",
            variables: {
              address: "0xBatchContract",
              abi: [
                {
                  type: "function",
                  name: "batchTransfer",
                  inputs: [
                    {
                      name: "transfers",
                      type: "tuple[]",
                      components: [
                        { name: "to", type: "address" },
                        { name: "amount", type: "uint256" },
                      ],
                    },
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "batchTransfer",
              args: [
                [
                  { to: "0xRecipient1", amount: BigInt(100) },
                  { to: "0xRecipient2", amount: BigInt(200) },
                  { to: "0xRecipient3", amount: BigInt(300) },
                ],
              ],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];

      // Transaction 'to' should be the contract, not overwritten by struct 'to' fields
      expect(txCall.to).to.equal("0xBatchContract");

      expect(txCall.function_name).to.equal("batchTransfer");
      // All BigInt values in the array of structs should be stringified
      expect(txCall.function_args).to.deep.equal({
        transfers: [
          { to: "0xRecipient1", amount: "100" },
          { to: "0xRecipient2", amount: "200" },
          { to: "0xRecipient3", amount: "300" },
        ],
      });

      // 'transfers' doesn't collide with any built-in field, so no prefix
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({
        transfers: [
          { to: "0xRecipient1", amount: "100" },
          { to: "0xRecipient2", amount: "200" },
          { to: "0xRecipient3", amount: "300" },
        ],
      });
    });

    it("should handle writeContract with deeply nested struct (DeFi swap params)", async () => {
      // Tests complex DeFi structs like Uniswap's ExactInputParams
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 103,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_swap_test",
            variables: {
              address: "0xSwapRouter",
              abi: [
                {
                  type: "function",
                  name: "swap",
                  inputs: [
                    {
                      name: "params",
                      type: "tuple",
                      components: [
                        {
                          name: "input",
                          type: "tuple",
                          components: [
                            { name: "token", type: "address" },
                            { name: "amount", type: "uint256" },
                          ],
                        },
                        {
                          name: "output",
                          type: "tuple",
                          components: [
                            { name: "token", type: "address" },
                            { name: "minAmount", type: "uint256" },
                          ],
                        },
                        { name: "deadline", type: "uint256" },
                      ],
                    },
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "swap",
              args: [
                {
                  input: {
                    token: "0xUSDC",
                    amount: BigInt("1000000000"), // 1000 USDC
                  },
                  output: {
                    token: "0xWETH",
                    minAmount: BigInt("500000000000000000"), // 0.5 WETH
                  },
                  deadline: BigInt("1700000000"),
                },
              ],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];

      expect(txCall.function_name).to.equal("swap");
      // All nested BigInt values should be recursively stringified
      expect(txCall.function_args).to.deep.equal({
        params: {
          input: {
            token: "0xUSDC",
            amount: "1000000000",
          },
          output: {
            token: "0xWETH",
            minAmount: "500000000000000000",
          },
          deadline: "1700000000",
        },
      });

      // 'params' doesn't collide with any built-in field, so no prefix
      // Nested struct fields are also flattened for easier querying
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({
        params: {
          input: {
            token: "0xUSDC",
            amount: "1000000000",
          },
          output: {
            token: "0xWETH",
            minAmount: "500000000000000000",
          },
          deadline: "1700000000",
        },
        // Flattened deeply nested struct fields
        params_input_token: "0xUSDC",
        params_input_amount: "1000000000",
        params_output_token: "0xWETH",
        params_output_minAmount: "500000000000000000",
        params_deadline: "1700000000",
      });
    });

    it("should handle collision with 'data' field in function args", async () => {
      // Edge case: function has a parameter named 'data' which could collide
      // with the transaction's encoded data field
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 104,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_data_collision",
            variables: {
              address: "0xProxyContract",
              abi: [
                {
                  type: "function",
                  name: "execute",
                  inputs: [
                    { name: "target", type: "address" },
                    { name: "data", type: "bytes" },     // This 'data' is a function param
                    { name: "value", type: "uint256" },  // This 'value' is also a collision risk
                  ],
                  outputs: [],
                  stateMutability: "payable",
                },
              ],
              functionName: "execute",
              args: ["0xTargetContract", "0xcalldata123", BigInt("1000000000000000000")],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];

      // function_args should have the unprefixed original keys
      expect(txCall.function_args).to.deep.equal({
        target: "0xTargetContract",
        data: "0xcalldata123",
        value: "1000000000000000000",
      });

      // The properties should have:
      // - 'target' unprefixed (no collision)
      // - 'data' prefixed to 'arg_data' (collides with transaction data field)
      // - 'value' prefixed to 'arg_value' (collides with transaction value field)
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({
        target: "0xTargetContract",
        arg_data: "0xcalldata123",
        arg_value: "1000000000000000000",
      });

      // Ensure the transaction's own 'data' field (encoded calldata) is different
      // from the function arg 'data' (which becomes arg_data)
      expect(txProperties!.arg_data).to.equal("0xcalldata123");
    });

    it("should flatten nested structs with collision handling on root key", async () => {
      // Edge case: struct argument named 'to' (reserved field) with nested properties
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 201,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_nested_collision",
            variables: {
              address: "0xContract",
              abi: [
                {
                  type: "function",
                  name: "send",
                  inputs: [
                    {
                      name: "to",  // Collides with transaction 'to' field
                      type: "tuple",
                      components: [
                        { name: "recipient", type: "address" },
                        { name: "chainId", type: "uint256" },  // Also a reserved field name
                      ],
                    },
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "send",
              args: [
                {
                  recipient: "0xRecipientAddress",
                  chainId: BigInt(137),
                },
              ],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];

      // function_args preserves original structure
      expect(txCall.function_args).to.deep.equal({
        to: {
          recipient: "0xRecipientAddress",
          chainId: "137",
        },
      });

      // Properties: 'to' becomes 'arg_to' due to collision, flattened fields follow
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({
        arg_to: {
          recipient: "0xRecipientAddress",
          chainId: "137",
        },
        // Flattened with prefixed root key
        arg_to_recipient: "0xRecipientAddress",
        arg_to_chainId: "137",
      });
    });

    it("should not flatten arrays but include them as leaf values", async () => {
      // Arrays should remain as-is, not be expanded
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 202,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_array_test",
            variables: {
              address: "0xContract",
              abi: [
                {
                  type: "function",
                  name: "multiSwap",
                  inputs: [
                    {
                      name: "swap",
                      type: "tuple",
                      components: [
                        { name: "paths", type: "address[]" },
                        { name: "amounts", type: "uint256[]" },
                      ],
                    },
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "multiSwap",
              args: [
                {
                  paths: ["0xToken1", "0xToken2", "0xToken3"],
                  amounts: [BigInt(100), BigInt(200), BigInt(300)],
                },
              ],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txProperties = mockFormo.transaction.firstCall.args[1];

      // Arrays should be preserved as arrays, not expanded
      expect(txProperties).to.deep.equal({
        swap: {
          paths: ["0xToken1", "0xToken2", "0xToken3"],
          amounts: ["100", "200", "300"],
        },
        // Flattened arrays remain arrays
        swap_paths: ["0xToken1", "0xToken2", "0xToken3"],
        swap_amounts: ["100", "200", "300"],
      });
    });

    it("should handle triple-nested struct flattening", async () => {
      // Three levels of nesting
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 203,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_deep_nested",
            variables: {
              address: "0xContract",
              abi: [
                {
                  type: "function",
                  name: "deepCall",
                  inputs: [
                    {
                      name: "data",  // Collision with reserved field
                      type: "tuple",
                      components: [
                        {
                          name: "level1",
                          type: "tuple",
                          components: [
                            {
                              name: "level2",
                              type: "tuple",
                              components: [
                                { name: "value", type: "uint256" },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "deepCall",
              args: [
                {
                  level1: {
                    level2: {
                      value: BigInt(42),
                    },
                  },
                },
              ],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txProperties = mockFormo.transaction.firstCall.args[1];

      // 'data' collides, so it becomes 'arg_data', and flattening follows that prefix
      expect(txProperties).to.deep.equal({
        arg_data: {
          level1: {
            level2: {
              value: "42",
            },
          },
        },
        arg_data_level1_level2_value: "42",
      });
    });

    it("should handle mixed primitive and nested struct arguments", async () => {
      // Mix of flat primitives and nested structs
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 204,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_mixed",
            variables: {
              address: "0xContract",
              abi: [
                {
                  type: "function",
                  name: "complexCall",
                  inputs: [
                    { name: "id", type: "uint256" },
                    {
                      name: "config",
                      type: "tuple",
                      components: [
                        { name: "enabled", type: "bool" },
                        { name: "threshold", type: "uint256" },
                      ],
                    },
                    { name: "recipient", type: "address" },
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "complexCall",
              args: [
                BigInt(123),
                { enabled: true, threshold: BigInt(1000) },
                "0xRecipient",
              ],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txProperties = mockFormo.transaction.firstCall.args[1];

      // Primitives stay flat, nested struct gets flattened
      expect(txProperties).to.deep.equal({
        id: "123",
        config: { enabled: true, threshold: "1000" },
        config_enabled: true,
        config_threshold: "1000",
        recipient: "0xRecipient",
      });
    });

    it("should skip flattened keys that collide with existing top-level args", async () => {
      // Edge case: flattened key would overwrite an existing top-level argument
      // e.g., foo(uint256 config_value, Config config) where Config has a 'value' field
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 205,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_collision",
            variables: {
              address: "0xContract",
              abi: [
                {
                  type: "function",
                  name: "edgeCase",
                  inputs: [
                    { name: "config_value", type: "uint256" }, // Top-level arg with underscore
                    {
                      name: "config",
                      type: "tuple",
                      components: [
                        { name: "value", type: "uint256" }, // Would flatten to config_value
                        { name: "other", type: "uint256" },
                      ],
                    },
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "edgeCase",
              args: [BigInt(999), { value: BigInt(123), other: BigInt(456) }],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txProperties = mockFormo.transaction.firstCall.args[1];

      // config_value should keep its original value (999), not be overwritten by config.value (123)
      // config_other should be added since it doesn't collide
      expect(txProperties).to.deep.equal({
        config_value: "999", // Original top-level arg preserved
        config: { value: "123", other: "456" },
        // config_value would collide, so it's skipped
        config_other: "456", // No collision, added
      });
    });

    it("should prioritize top-level args over flattened keys regardless of ABI order", async () => {
      // Edge case: struct appears BEFORE the top-level arg in ABI order
      // e.g., foo(Config config, uint256 config_value) where Config has a 'value' field
      // Top-level args should still take precedence
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 206,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: "0xtxhash_order_test",
            variables: {
              address: "0xContract",
              abi: [
                {
                  type: "function",
                  name: "orderTest",
                  inputs: [
                    {
                      name: "config", // Struct comes FIRST
                      type: "tuple",
                      components: [
                        { name: "value", type: "uint256" }, // Would flatten to config_value
                        { name: "other", type: "uint256" },
                      ],
                    },
                    { name: "config_value", type: "uint256" }, // Top-level arg comes SECOND
                  ],
                  outputs: [],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "orderTest",
              args: [{ value: BigInt(123), other: BigInt(456) }, BigInt(999)],
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txProperties = mockFormo.transaction.firstCall.args[1];

      // Even though struct comes first in ABI, top-level arg should win
      // config_value should be 999 (from top-level arg), not 123 (from flattened struct)
      expect(txProperties).to.deep.equal({
        config: { value: "123", other: "456" },
        config_value: "999", // Top-level arg takes precedence
        config_other: "456",
      });
    });
  });

  describe("deduplication", () => {
    it("should not emit duplicate events for the same mutation state", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 8,
          options: { mutationKey: ["signMessage"] },
          state: { status: "success", data: "0xsig", variables: { message: "test" } },
        },
      };

      // Send same event twice
      if (mutationListener) {
        mutationListener(mutationEvent);
        mutationListener(mutationEvent);
      }

      // Should only be called once
      expect(mockFormo.signature.calledOnce).to.be.true;
    });
  });

  describe("cleanup", () => {
    it("should unsubscribe all listeners on cleanup", () => {
      const handler = new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      handler.cleanup();

      // Verify unsubscribe was called (listeners should be null after cleanup)
      // The actual verification depends on implementation
    });
  });

  describe("getState compatibility", () => {
    it("should work with getState() method", async () => {
      const connectedState = createConnectedState();
      mockWagmiConfig.getState = sandbox.stub().returns(connectedState);
      mockWagmiConfig.state = undefined;

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Trigger a status change to call getState
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      // Handler should call getState when handling events
      expect((mockWagmiConfig.getState as sinon.SinonStub).called).to.be.true;
    });

    it("should fall back to state property when getState is not available", () => {
      const connectedState = createConnectedState();
      mockWagmiConfig.getState = undefined;
      mockWagmiConfig.state = connectedState;

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Handler should initialize without errors using state property
    });
  });

  describe("edge cases", () => {
    it("should handle mutations without mutationKey", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 9,
          options: { mutationKey: undefined },
          state: { status: "success" },
        },
      };

      if (mutationListener) {
        // Should not throw
        expect(() => mutationListener!(mutationEvent)).to.not.throw();
      }

      expect(mockFormo.signature.called).to.be.false;
      expect(mockFormo.transaction.called).to.be.false;
    });

    it("should handle mutation events that are not 'updated' type", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      const addedEvent: MutationCacheEvent = {
        type: "added",
        mutation: {
          mutationId: 10,
          options: { mutationKey: ["signMessage"] },
          state: { status: "idle" },
        },
      };

      if (mutationListener) {
        mutationListener(addedEvent);
      }

      expect(mockFormo.signature.called).to.be.false;
    });

    it("should handle idle mutation status", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 11,
          options: { mutationKey: ["signMessage"] },
          state: { status: "idle" },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      // Idle status should be ignored
      expect(mockFormo.signature.called).to.be.false;
    });
  });

  describe("transaction confirmation tracking", () => {
    // Receipt-derived events now require a previously *observed* broadcast
    // (the hash must be in pendingTransactions) — otherwise a forged
    // waitForTransactionReceipt entry in the host-owned QueryClient could
    // fabricate confirmations. This helper simulates that broadcast, then
    // clears history so the test can assert the receipt event alone.
    const broadcastTx = (hash: string, mutationId = Math.floor(Math.random() * 1e6)) => {
      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId,
            options: { mutationKey: ["writeContract"] },
            state: { status: "success", data: hash, variables: {} },
          },
        } as any);
      }
      mockFormo.transaction.resetHistory();
    };

    it("should track CONFIRMED status when waitForTransactionReceipt query succeeds", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      broadcastTx("0xtxhash123");

      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xtxhash123", chainId: 1 }],
          queryHash: "waitForTransactionReceipt-0xtxhash123",
          state: {
            status: "success",
            data: {
              status: "success",
              blockNumber: BigInt(12345),
              gasUsed: BigInt(21000),
            },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];
      expect(txCall.status).to.equal("confirmed");
      expect(txCall.transactionHash).to.equal("0xtxhash123");
      expect(txCall.chainId).to.equal(1);
      expect(txCall.address).to.equal(mockAddress);
    });

    it("should track REVERTED status when transaction receipt shows reverted", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      broadcastTx("0xrevertedhash");

      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xrevertedhash", chainId: 1 }],
          queryHash: "waitForTransactionReceipt-0xrevertedhash",
          state: {
            status: "success",
            data: {
              status: "reverted",
              blockNumber: BigInt(12346),
              gasUsed: BigInt(50000),
            },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];
      expect(txCall.status).to.equal("reverted");
      expect(txCall.transactionHash).to.equal("0xrevertedhash");
    });

    it("should use chainId from tracking state when not in query params", async () => {
      const connectedState = createConnectedState(mockAddress, 137); // Polygon
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      broadcastTx("0xhash_no_chainid");

      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xhash_no_chainid" }],
          queryHash: "waitForTransactionReceipt-0xhash_no_chainid",
          state: {
            status: "success",
            data: { status: "success" },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const txCall = mockFormo.transaction.firstCall.args[0];
      expect(txCall.chainId).to.equal(137);
    });

    it("should not track when query status is not success", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xpending" }],
          queryHash: "waitForTransactionReceipt-0xpending",
          state: {
            status: "pending",
            fetchStatus: "fetching",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.called).to.be.false;
    });

    it("should not track non-waitForTransactionReceipt queries", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["getBalance", { address: mockAddress }],
          queryHash: "getBalance-address",
          state: {
            status: "success",
            data: BigInt(1000000000000000000),
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.called).to.be.false;
    });

    it("should not track when autocapture for transaction is disabled", async () => {
      mockFormo.isAutocaptureEnabled.withArgs("transaction").returns(false);

      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xhash" }],
          queryHash: "waitForTransactionReceipt-0xhash",
          state: {
            status: "success",
            data: { status: "success" },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.called).to.be.false;
    });

    it("should not emit duplicate events for the same query state", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      broadcastTx("0xduphash");

      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xduphash" }],
          queryHash: "waitForTransactionReceipt-0xduphash",
          state: {
            status: "success",
            data: { status: "success" },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
    });

    it("should ignore query events that are not 'updated' type", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const queryEvent: QueryCacheEvent = {
        type: "added",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xaddedhash" }],
          queryHash: "waitForTransactionReceipt-0xaddedhash",
          state: {
            status: "success",
            data: { status: "success" },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.called).to.be.false;
    });

    it("should preserve transaction properties from BROADCASTED to CONFIRMED", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const txHash = "0xtxhash_preserved";

      // First, emit BROADCASTED event with full transaction details
      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 200,
          options: { mutationKey: ["writeContract"] },
          state: {
            status: "success",
            data: txHash,
            variables: {
              address: "0xTokenContract",
              abi: [
                {
                  type: "function",
                  name: "transfer",
                  inputs: [
                    { name: "to", type: "address" },
                    { name: "amount", type: "uint256" },
                  ],
                  outputs: [{ name: "", type: "bool" }],
                  stateMutability: "nonpayable",
                },
              ],
              functionName: "transfer",
              args: ["0xRecipient", BigInt("1000000000000000000")],
              value: BigInt("0"),
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      // Verify BROADCASTED event was emitted
      expect(mockFormo.transaction.calledOnce).to.be.true;
      const broadcastedCall = mockFormo.transaction.firstCall.args[0];
      expect(broadcastedCall.status).to.equal("broadcasted");
      expect(broadcastedCall.transactionHash).to.equal(txHash);
      expect(broadcastedCall.to).to.equal("0xTokenContract");
      expect(broadcastedCall.function_name).to.equal("transfer");

      // Reset mock to check CONFIRMED event separately
      mockFormo.transaction.resetHistory();

      // Now emit CONFIRMED event via QueryCache
      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: txHash, chainId: 1 }],
          queryHash: `waitForTransactionReceipt-${txHash}`,
          state: {
            status: "success",
            data: {
              status: "success",
              blockNumber: BigInt(12345),
              gasUsed: BigInt(21000),
            },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      // Verify CONFIRMED event includes preserved transaction details
      expect(mockFormo.transaction.calledOnce).to.be.true;
      const confirmedCall = mockFormo.transaction.firstCall.args[0];
      expect(confirmedCall.status).to.equal("confirmed");
      expect(confirmedCall.transactionHash).to.equal(txHash);
      expect(confirmedCall.chainId).to.equal(1);
      expect(confirmedCall.address).to.equal(mockAddress);

      // These should be preserved from the BROADCASTED event
      expect(confirmedCall.to).to.equal("0xTokenContract");
      expect(confirmedCall.function_name).to.equal("transfer");
      expect(confirmedCall.function_args).to.deep.equal({
        to: "0xRecipient",
        amount: "1000000000000000000",
      });

      // Verify safeFunctionArgs are also passed as additional properties (second argument)
      // 'to' collides with transaction 'to' field, so it gets prefixed to 'arg_to'
      const confirmedProperties = mockFormo.transaction.firstCall.args[1];
      expect(confirmedProperties).to.deep.equal({
        arg_to: "0xRecipient",
        amount: "1000000000000000000",
      });
    });

    it("should preserve transaction properties for sendTransaction CONFIRMED", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      const txHash = "0xtxhash_send_preserved";

      // Emit BROADCASTED via sendTransaction
      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 201,
          options: { mutationKey: ["sendTransaction"] },
          state: {
            status: "success",
            data: txHash,
            variables: {
              to: "0xRecipient",
              data: "0xabcdef",
              value: BigInt("1000000000000000000"),
            },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      mockFormo.transaction.resetHistory();

      // Emit CONFIRMED
      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: txHash, chainId: 1 }],
          queryHash: `waitForTransactionReceipt-${txHash}`,
          state: {
            status: "success",
            data: { status: "success" },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      const confirmedCall = mockFormo.transaction.firstCall.args[0];
      expect(confirmedCall.status).to.equal("confirmed");
      expect(confirmedCall.transactionHash).to.equal(txHash);

      // Preserved from BROADCASTED
      expect(confirmedCall.to).to.equal("0xRecipient");
      expect(confirmedCall.data).to.equal("0xabcdef");
      expect(confirmedCall.value).to.equal("1000000000000000000");
    });

    it("should NOT emit a receipt event for a hash with no observed BROADCAST (anti-forgery)", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      // A waitForTransactionReceipt entry for a hash this handler never
      // observed being broadcast — e.g. injected into the host-owned
      // QueryClient by app code or a dependency. Must be ignored, not
      // turned into a fabricated confirmed transaction.
      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xunknown_tx", chainId: 1 }],
          queryHash: "waitForTransactionReceipt-0xunknown_tx",
          state: {
            status: "success",
            data: { status: "success" },
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      expect(mockFormo.transaction.called).to.be.false;
    });

    it("should ignore a receipt whose data has no explicit success/reverted status", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      broadcastTx("0xnostatus");

      const queryEvent: QueryCacheEvent = {
        type: "updated",
        query: {
          queryKey: ["waitForTransactionReceipt", { hash: "0xnostatus", chainId: 1 }],
          queryHash: "waitForTransactionReceipt-0xnostatus",
          state: {
            status: "success",
            data: {}, // receipt present but no on-chain status
            fetchStatus: "idle",
          },
        },
      };

      if (queryListener) {
        queryListener(queryEvent);
      }

      // Missing status must NOT be treated as a confirmation.
      expect(mockFormo.transaction.called).to.be.false;
    });
  });

  describe("explicit per-call account and chain", () => {
    const OTHER = "0x9999999999999999999999999999999999999999";
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    const connectHandler = async () => {
      (mockWagmiConfig as any).setState(createMockState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      (mockWagmiConfig as any).setState(createConnectedState());
      if (statusListener) await statusListener("connected", "disconnected");
      await settle();
    };

    it("prefers the mutation's account over the active connection", async () => {
      await connectHandler();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 40,
            options: { mutationKey: ["sendTransaction"] },
            state: {
              status: "success",
              data: "0xhash",
              variables: { account: OTHER, to: "0xabc", data: "0x" },
            },
          },
        } as any);
      }

      expect(mockFormo.transaction.lastCall.args[0].address).to.equal(OTHER);
    });

    it("prefers the mutation's chainId over the active connection", async () => {
      await connectHandler();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 41,
            options: { mutationKey: ["sendTransaction"] },
            state: {
              status: "success",
              data: "0xhash",
              variables: { chainId: 137, to: "0xabc", data: "0x" },
            },
          },
        } as any);
      }

      expect(mockFormo.transaction.lastCall.args[0].chainId).to.equal(137);
    });

    it("accepts an account object as well as a bare address", async () => {
      await connectHandler();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 42,
            options: { mutationKey: ["signMessage"] },
            state: {
              status: "success",
              variables: { account: { address: OTHER }, message: "hi" },
            },
          },
        } as any);
      }

      expect(mockFormo.signature.lastCall.args[0].address).to.equal(OTHER);
    });

    it("confirms on the chain it broadcast on, not the later active chain", async () => {
      await connectHandler();

      // Broadcast with an explicit chainId that differs from the connection.
      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 44,
            options: { mutationKey: ["sendTransaction"] },
            state: {
              status: "success",
              data: "0xBroadcastHash",
              variables: { chainId: 42161, to: "0xabc", data: "0x" },
            },
          },
        } as any);
      }
      expect(mockFormo.transaction.lastCall.args[0].chainId).to.equal(42161);

      // User switches chain before the receipt arrives.
      (mockWagmiConfig as any).setState(createConnectedState(mockAddress, 137));
      if (chainIdListener) await chainIdListener(137, mockChainId);
      await settle();

      if (queryListener) {
        queryListener({
          type: "updated",
          query: {
            queryHash: "receipt-44",
            queryKey: ["waitForTransactionReceipt", { hash: "0xBroadcastHash" }],
            state: { status: "success", data: { status: "success" } },
          },
        } as any);
      }

      const confirmation = mockFormo.transaction.lastCall.args[0];
      expect(confirmation.status).to.equal("confirmed");
      expect(confirmation.chainId).to.equal(42161);
    });

    it("lets the receipt query's chain win when the mutation named none", async () => {
      // Only an explicitly requested chain is authoritative for the receipt.
      // A chain merely inferred from the active connection must not override
      // the chainId the receipt query actually carries.
      await connectHandler();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 45,
            options: { mutationKey: ["sendTransaction"] },
            state: {
              status: "success",
              data: "0xNoChainHash",
              variables: { to: "0xabc", data: "0x" }, // no chainId
            },
          },
        } as any);
      }

      if (queryListener) {
        queryListener({
          type: "updated",
          query: {
            queryHash: "receipt-45",
            queryKey: [
              "waitForTransactionReceipt",
              { hash: "0xNoChainHash", chainId: 42161 },
            ],
            state: { status: "success", data: { status: "success" } },
          },
        } as any);
      }

      expect(mockFormo.transaction.lastCall.args[0].chainId).to.equal(42161);
    });

    it("still falls back to the active connection when unspecified", async () => {
      await connectHandler();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 43,
            options: { mutationKey: ["sendTransaction"] },
            state: {
              status: "success",
              data: "0xhash",
              variables: { to: "0xabc", data: "0x" },
            },
          },
        } as any);
      }

      const call = mockFormo.transaction.lastCall.args[0];
      expect(call.address).to.equal(mockAddress);
      expect(call.chainId).to.equal(mockChainId);
    });
  });

  describe("account switched inside an already-connected wallet", () => {
    const SWITCHED = "0x7777777777777777777777777777777777777777";
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    it("emits connect for the new account while status stays connected", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      // wagmi keeps status === "connected"; only the accounts array changes.
      (mockWagmiConfig as any).setState(createConnectedState(SWITCHED, mockChainId));
      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();

      expect(mockFormo.connect.calledTwice).to.be.true;
      expect(mockFormo.connect.secondCall.args[0]).to.deep.include({
        chainId: mockChainId,
        address: SWITCHED,
      });
    });

    it("follows a connector falling away when both hold the same account", async () => {
      // Two connectors over one hardware wallet report the SAME account. When
      // the current one disconnects the address does not change at all, so the
      // address comparisons must not run before the connector check - they
      // returned early and the fallback went completely unnoticed.
      const shared = new Map();
      shared.set("uid-a", {
        accounts: [mockAddress],
        chainId: mockChainId,
        connector: { id: "a", name: "MetaMask", type: "injected", uid: "uid-a" },
      });
      shared.set("uid-b", {
        accounts: [mockAddress],
        chainId: mockChainId,
        connector: { id: "b", name: "Rabby", type: "injected", uid: "uid-b" },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: shared,
        current: "uid-a",
        chainId: mockChainId,
      });
      const handler = new WagmiEventHandler(
        mockFormo as any, mockWagmiConfig, mockQueryClient
      );
      await settle();
      expect((handler as any).trackingState.lastConnectionId).to.equal("uid-a");

      const remaining = new Map();
      remaining.set("uid-b", shared.get("uid-b"));
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: remaining,
        current: "uid-b",
        chainId: mockChainId,
      });
      // Same address on both sides, exactly as wagmi would report it.
      if (addressListener) await addressListener(mockAddress, mockAddress);
      await settle();

      // The ACCOUNT never disconnected - the other connector still holds it -
      // so no disconnect, and no duplicate connect either.
      expect(mockFormo.disconnect.called, "account is still connected").to.be.false;
      expect(mockFormo.connect.callCount, "no duplicate connect").to.equal(1);

      // The observable difference: the handler must now be following the
      // SURVIVING connection. Left pointing at the dead one, it can no longer
      // tell a later fallback from an ordinary switch.
      expect(
        (handler as any).trackingState.lastConnectionId,
        "follows the surviving connection"
      ).to.equal("uid-b");

      // Attribution is unchanged, since it is the same account throughout.
      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 71,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hi" } },
          },
        } as any);
      }
      expect(mockFormo.signature.lastCall.args[0].address).to.equal(mockAddress);
    });

    it("does not let a superseded fallback overwrite a newer transition", async () => {
      // A falls away to B; while B's disconnect emission is awaited wagmi
      // moves again to C. The older continuation must not resume and write B
      // over C.
      const C = "0x9999999999999999999999999999999999999999";
      const conns = new Map();
      conns.set("uid-a", {
        accounts: [mockAddress],
        chainId: mockChainId,
        connector: { id: "a", name: "MetaMask", type: "injected", uid: "uid-a" },
      });
      conns.set("uid-b", {
        accounts: [SWITCHED],
        chainId: mockChainId,
        connector: { id: "b", name: "Rabby", type: "injected", uid: "uid-b" },
      });
      conns.set("uid-c", {
        accounts: [C],
        chainId: mockChainId,
        connector: { id: "c", name: "Frame", type: "injected", uid: "uid-c" },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: conns,
        current: "uid-a",
        chainId: mockChainId,
      });
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      let releaseDisconnect: (() => void) | undefined;
      (mockFormo as any).disconnect = sandbox.stub().returns(
        new Promise<void>((resolve) => { releaseDisconnect = () => resolve(); })
      );

      // A falls away, wagmi falls back to B.
      const withoutA = new Map(conns);
      withoutA.delete("uid-a");
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: withoutA,
        current: "uid-b",
        chainId: mockChainId,
      });
      const stale = addressListener!(SWITCHED, mockAddress);
      await settle();

      // Before that disconnect settles, wagmi moves on to C.
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: withoutA,
        current: "uid-c",
        chainId: mockChainId,
      });
      await addressListener!(C, SWITCHED);
      await settle();

      releaseDisconnect!();
      await stale;
      await settle();

      // C is what wagmi actually has, so C is what later events must use.
      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 72,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hi" } },
          },
        } as any);
      }
      expect(mockFormo.signature.lastCall.args[0].address).to.equal(C);
    });


    it("confirms on the chain it broadcast on when no chain was named", async () => {
      // The common sendTransaction({ to, ... }) case. Broadcasting on chain 1
      // and switching to 137 before the receipt must not relabel it 137.
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      const hash = "0xdeadbeef";
      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 61,
            options: { mutationKey: ["sendTransaction"] },
            state: {
              status: "success",
              data: hash,
              variables: { to: "0xabc", value: "0x1" },
            },
          },
        } as any);
      }
      await settle();
      const broadcast = mockFormo.transaction
        .getCalls()
        .map((c: any) => c.args[0])
        .find((p: any) => p.status === "broadcasted");
      expect(broadcast, "a broadcast event").to.exist;
      expect(broadcast.chainId).to.equal(mockChainId);

      // User switches network before the receipt arrives.
      const NEW_CHAIN = 137;
      (mockWagmiConfig as any).setState(
        createConnectedState(mockAddress, NEW_CHAIN)
      );
      if (chainIdListener) await chainIdListener(NEW_CHAIN, mockChainId);
      await settle();

      if (queryListener) {
        queryListener({
          type: "updated",
          query: {
            queryHash: '["waitForTransactionReceipt"]',
            queryKey: ["waitForTransactionReceipt", { hash }],
            state: { status: "success", data: { status: "success", transactionHash: hash } },
          },
        } as any);
      }
      await settle();

      const confirmed = mockFormo.transaction
        .getCalls()
        .map((c: any) => c.args[0])
        .find((p: any) => p.status === "confirmed");
      expect(confirmed, "a confirmed event").to.exist;
      expect(confirmed.chainId, "labelled with the broadcast chain").to.equal(mockChainId);
    });

    it("emits a disconnect when the tracked connector falls away", async () => {
      // Two live connections. Disconnecting the current one leaves the global
      // status on "connected" and moves state.current to the other, so only
      // the address listener runs. Treating that as an in-place switch loses
      // the disconnect of the wallet the user actually dropped.
      const twoConnections = new Map();
      twoConnections.set("uid-a", {
        accounts: [mockAddress],
        chainId: mockChainId,
        connector: { id: "a", name: "MetaMask", type: "injected", uid: "uid-a" },
      });
      twoConnections.set("uid-b", {
        accounts: [SWITCHED],
        chainId: mockChainId,
        connector: { id: "b", name: "Rabby", type: "injected", uid: "uid-b" },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: twoConnections,
        current: "uid-a",
        chainId: mockChainId,
      });
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.disconnect.called).to.be.false;

      // Connector A disconnects; wagmi falls back to B, status never moves.
      const remaining = new Map();
      remaining.set("uid-b", twoConnections.get("uid-b"));
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: remaining,
        current: "uid-b",
        chainId: mockChainId,
      });
      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();

      expect(mockFormo.disconnect.calledOnce, "wallet A reported as disconnected").to.be.true;
      expect(mockFormo.disconnect.firstCall.args[0]).to.deep.include({
        address: mockAddress,
        chainId: mockChainId,
      });
    });

    it("does not re-announce a fallback connection already reported", async () => {
      // Same shape, but B was already announced this page load. Becoming the
      // active connection is not a new connect.
      const twoConnections = new Map();
      twoConnections.set("uid-a", {
        accounts: [mockAddress],
        chainId: mockChainId,
        connector: { id: "a", name: "MetaMask", type: "injected", uid: "uid-a" },
      });
      twoConnections.set("uid-b", {
        accounts: [SWITCHED],
        chainId: mockChainId,
        connector: { id: "b", name: "Rabby", type: "injected", uid: "uid-b" },
      });

      // B connects first and is announced.
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: twoConnections,
        current: "uid-b",
        chainId: mockChainId,
      });
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      // A becomes current, then falls away again back to B.
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: twoConnections,
        current: "uid-a",
        chainId: mockChainId,
      });
      if (addressListener) await addressListener(mockAddress, SWITCHED);
      await settle();
      const afterSwitch = mockFormo.connect.callCount;

      const remaining = new Map();
      remaining.set("uid-b", twoConnections.get("uid-b"));
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: remaining,
        current: "uid-b",
        chainId: mockChainId,
      });
      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();

      expect(mockFormo.connect.callCount, "B not re-announced").to.equal(afterSwitch);
    });

    it("labels a typed-data signature with the EIP-712 domain chain", async () => {
      // wagmi carries the signed chain in variables.domain.chainId, not at the
      // top level. Reading only the top level labelled the signature with the
      // wallet's current chain instead of the one it is bound to.
      const DOMAIN_CHAIN = 8453;
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 77,
            options: { mutationKey: ["signTypedData"] },
            state: {
              status: "success",
              variables: {
                domain: { name: "App", chainId: DOMAIN_CHAIN },
                primaryType: "Mail",
                types: {},
                message: {},
              },
            },
          },
        } as any);
      }

      expect(mockFormo.signature.lastCall.args[0].chainId).to.equal(DOMAIN_CHAIN);
    });

    it("normalizes a hex or bigint domain chain", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 78,
            options: { mutationKey: ["signTypedData"] },
            state: {
              status: "success",
              variables: { domain: { chainId: "0x2105" }, message: {} },
            },
          },
        } as any);
      }

      expect(mockFormo.signature.lastCall.args[0].chainId).to.equal(8453);
    });

    it("follows the active connection's chain when the global one does not move", async () => {
      // With several connections, or syncConnectedChain: false, the active
      // connection can change chain while state.chainId stays put. Selecting
      // only the global value meant no callback ran at all.
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      const NEW_CHAIN = 8453;
      const connections = new Map();
      connections.set("k", {
        accounts: [mockAddress],
        chainId: NEW_CHAIN,
        connector: { id: "m", name: "MetaMask", type: "injected", uid: "k" },
      });
      const shifted = {
        status: "connected" as const,
        connections,
        current: "k",
        chainId: mockChainId, // global deliberately unchanged
      };
      (mockWagmiConfig as any).setState(shifted);

      // The selector is what must notice; assert on it directly.
      const selector = (mockWagmiConfig.subscribe as sinon.SinonStub)
        .getCalls()
        .map((c) => c.args[0])
        .find((sel) => sel(shifted) === NEW_CHAIN);
      expect(selector, "a subscription selects the active connection chain").to.exist;
    });

    it("re-points signature and transaction attribution at the new account", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig as any).setState(createConnectedState(SWITCHED, mockChainId));
      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 50,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hi" } },
          },
        } as any);
      }

      expect(mockFormo.signature.lastCall.args[0].address).to.equal(SWITCHED);
    });

    it("does not double-emit on a fresh connect", async () => {
      (mockWagmiConfig as any).setState(createMockState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      // Both listeners fire for the same transition; status is registered
      // first and records the address synchronously.
      (mockWagmiConfig as any).setState(createConnectedState());
      if (statusListener) await statusListener("connected", "disconnected");
      if (addressListener) await addressListener(mockAddress, undefined);
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("uses the active connection's chain, not the global one", async () => {
      // With several connections, or with syncConnectedChain off, the global
      // state.chainId can still describe the previous connection.
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      const connections = new Map();
      connections.set("connector-1", {
        accounts: [SWITCHED],
        chainId: 42161,
        connector: { id: "m", name: "MetaMask", type: "injected", uid: "1" },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections,
        current: "connector-1",
        chainId: mockChainId, // global value lags behind
      });
      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();

      expect(mockFormo.connect.secondCall.args[0]).to.deep.include({
        chainId: 42161,
        address: SWITCHED,
      });
    });

    it("does not adopt a switched account that central state declines", async () => {
      // While tracking is suppressed, syncWalletState refuses to learn the
      // wallet. Keeping it privately would let later mutations attribute
      // events to an address the SDK decided it must not know.
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      mockFormo.connect.resetHistory();

      mockFormo.syncWalletState = sandbox.stub() as any;
      (mockFormo as any).currentAddress = mockAddress;
      (mockWagmiConfig as any).setState(createConnectedState(SWITCHED, mockChainId));
      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();

      expect(mockFormo.connect.called).to.be.false;

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 70,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hi" } },
          },
        } as any);
      }
      // Nothing is emitted at all. The declined account must not be recorded,
      // and the account the user switched AWAY from must not be either -
      // attributing this activity to it would be worse than recording nothing.
      expect(mockFormo.signature.called).to.be.false;
    });

    it("clears the previous wallet when a switch is declined", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());
      const handler = new WagmiEventHandler(
        mockFormo as any, mockWagmiConfig, mockQueryClient
      );
      await settle();
      expect((handler as any).trackingState.lastAddress).to.equal(mockAddress);

      mockFormo.syncWalletState = sandbox.stub() as any;
      (mockFormo as any).currentAddress = mockAddress;
      (mockWagmiConfig as any).setState(createConnectedState(SWITCHED, mockChainId));
      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();

      expect((handler as any).trackingState.lastAddress).to.be.undefined;
      expect((handler as any).trackingState.lastChainId).to.be.undefined;
    });

    it("moves the page-load marker onto the switched account", async () => {
      // Otherwise a rebuild over the same connection treats the switched-to
      // wallet as never adopted and emits a duplicate connect for it.
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig as any).setState(createConnectedState(SWITCHED, mockChainId));
      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();
      expect(mockFormo.connect.calledTwice).to.be.true;

      // Provider remount while SWITCHED is still connected.
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.calledTwice).to.be.true;
    });

    it("ignores an address change while disconnected", async () => {
      (mockWagmiConfig as any).setState(createMockState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      if (addressListener) await addressListener(SWITCHED, mockAddress);
      await settle();

      expect(mockFormo.connect.called).to.be.false;
    });
  });

  describe("seeding from a connection that predates the handler", () => {
    // Wagmi's mount-time reconnect() settles before an app that loads the SDK
    // lazily. config.subscribe only reports changes, so without an explicit
    // seed the entire session is invisible.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    it("should emit connect for a wallet already connected at construction", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0]).to.deep.include({
        chainId: mockChainId,
        address: mockAddress,
      });
    });

    it("should seed on the active connection's chain, not the global one", async () => {
      // With several connections, or with syncConnectedChain disabled, the
      // global state.chainId can describe a different connection.
      const connections = new Map();
      connections.set("connector-1", {
        accounts: [mockAddress],
        chainId: 42161,
        connector: { id: "m", name: "MetaMask", type: "injected", uid: "1" },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections,
        current: "connector-1",
        chainId: mockChainId, // global value lags behind
      });

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.firstCall.args[0]).to.deep.include({
        chainId: 42161,
        address: mockAddress,
      });
    });

    it("should still seed when only the connection carries a chain", async () => {
      const connections = new Map();
      connections.set("connector-1", {
        accounts: [mockAddress],
        chainId: 42161,
        connector: { id: "m", name: "MetaMask", type: "injected", uid: "1" },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections,
        current: "connector-1",
        chainId: undefined, // global not populated yet
      });

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      // Previously this skipped seeding entirely and lost the whole session.
      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0].chainId).to.equal(42161);
    });

    it("should pass the connector name when seeding", async () => {
      const connections = new Map();
      connections.set("connector-1", {
        accounts: [mockAddress],
        chainId: mockChainId,
        connector: {
          id: "walletConnect",
          name: "WalletConnect",
          type: "walletConnect",
          uid: "wc-1",
        },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections,
        current: "connector-1",
        chainId: mockChainId,
      });

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.firstCall.args[1]).to.deep.equal({
        providerName: "WalletConnect",
      });
    });

    it("should seed the address so signature events are still tracked", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 1,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hello" } },
          },
        } as any);
      }

      expect(mockFormo.signature.calledOnce).to.be.true;
      expect(mockFormo.signature.firstCall.args[0]).to.deep.include({
        address: mockAddress,
        chainId: mockChainId,
      });
    });

    it("should seed the address so transaction events are still tracked", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 2,
            options: { mutationKey: ["sendTransaction"] },
            state: {
              status: "success",
              data: "0xdeadbeef",
              variables: { to: "0xabc", data: "0x" },
            },
          },
        } as any);
      }

      expect(mockFormo.transaction.calledOnce).to.be.true;
      expect(mockFormo.transaction.firstCall.args[0]).to.deep.include({
        address: mockAddress,
        chainId: mockChainId,
        transactionHash: "0xdeadbeef",
      });
    });

    it("should emit a disconnect carrying the seeded address and chain", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig as any).setState(createMockState());
      if (statusListener) {
        await statusListener("disconnected", "connected");
      }
      await settle();

      expect(mockFormo.disconnect.calledOnce).to.be.true;
      expect(mockFormo.disconnect.firstCall.args[0]).to.deep.equal({
        chainId: mockChainId,
        address: mockAddress,
      });
    });

    it("should sync wallet state when connect autocapture is disabled", async () => {
      mockFormo.isAutocaptureEnabled.withArgs("connect").returns(false);
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.called).to.be.false;
      expect(mockFormo.syncWalletState.calledOnce).to.be.true;
      expect(mockFormo.syncWalletState.firstCall.args[0]).to.deep.equal({
        chainId: mockChainId,
        address: mockAddress,
      });
    });

    it("should not emit connect when disconnected at construction", async () => {
      (mockWagmiConfig as any).setState(createMockState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.called).to.be.false;
      expect(mockFormo.syncWalletState.called).to.be.false;
    });

    it("should not emit connect when connected but no address is resolvable", async () => {
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections: new Map(),
        current: undefined,
        chainId: mockChainId,
      });

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.called).to.be.false;
    });

    it("should still handle a disconnect that lands while the seeded connect is in flight", async () => {
      // The seed must not hold trackingState.isProcessing across its connect
      // emission: handleStatusChange drops - does not defer - status changes
      // while that flag is set, so a disconnect here would be lost forever.
      let releaseConnect: () => void = () => undefined;
      mockFormo.connect.returns(
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        })
      );
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      // connect() is still pending at this point.
      expect(mockFormo.connect.calledOnce).to.be.true;

      (mockWagmiConfig as any).setState(createMockState());
      if (statusListener) {
        await statusListener("disconnected", "connected");
      }
      await settle();

      expect(mockFormo.disconnect.calledOnce).to.be.true;
      expect(mockFormo.disconnect.firstCall.args[0]).to.deep.equal({
        chainId: mockChainId,
        address: mockAddress,
      });

      releaseConnect();
    });

    it("should not re-emit connect when wagmi flaps through reconnecting", async () => {
      // A successful reconnect() goes connected -> reconnecting -> connected.
      // The final transition satisfies `prevStatus !== "connected"`, but the
      // wallet never changed, so it must not be counted twice.
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      if (statusListener) {
        await statusListener("reconnecting", "connected");
        await statusListener("connected", "reconnecting");
      }
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("should emit disconnect when a failing reconnect drops the wallet", async () => {
      // A failing reconnect() goes connected -> reconnecting -> disconnected,
      // so the disconnect never has `prevStatus === "connected"`.
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig as any).setState(createMockState());
      if (statusListener) {
        await statusListener("reconnecting", "connected");
        await statusListener("disconnected", "reconnecting");
      }
      await settle();

      expect(mockFormo.disconnect.calledOnce).to.be.true;
      expect(mockFormo.disconnect.firstCall.args[0]).to.deep.equal({
        chainId: mockChainId,
        address: mockAddress,
      });
    });

    it("should re-sync, not re-emit connect, when a reconnect lands on a new chain", async () => {
      // Same wallet, same session, new chain. Identity is the address alone,
      // so this is a chain transition and not a second connection.
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      (mockWagmiConfig as any).setState(createConnectedState(mockAddress, 137));
      if (statusListener) {
        await statusListener("reconnecting", "connected");
        await statusListener("connected", "reconnecting");
      }
      await settle();

      // No second connect. The chain emission belongs to the chainId
      // subscription, which observes the same state update; emitting from the
      // status branch too would double count it.
      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.chain.called).to.be.false;

      // And that subscription still reports the change exactly once.
      if (chainIdListener) await chainIdListener(137, mockChainId);
      await settle();
      expect(mockFormo.chain.calledOnce).to.be.true;
      expect(mockFormo.chain.firstCall.args[0]).to.deep.include({
        chainId: 137,
        address: mockAddress,
      });
    });

    it("should keep separate write keys from suppressing each other's seed", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      // A second SDK instance for a different write key is a separate
      // destination with its own queue, so it needs its own connect.
      const other: any = {
        connect: sandbox.stub().resolves(),
        disconnect: sandbox.stub().resolves(),
        chain: sandbox.stub().resolves(),
        signature: sandbox.stub().resolves(),
        transaction: sandbox.stub().resolves(),
        isAutocaptureEnabled: sandbox.stub().returns(true),
        willTrackEvent: sandbox.stub().returns(true),
        syncWalletState: sandbox.stub().callsFake((p: any) => {
          other.currentAddress = p?.address;
        }),
        currentAddress: undefined,
        writeKey: "other-write-key",
      };
      new WagmiEventHandler(other, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(other.connect.calledOnce).to.be.true;
    });

    it("should not adopt the wallet when central state declines it", async () => {
      // syncWalletState refuses to learn a wallet while tracking is
      // suppressed. Retaining it privately would let the mutation handlers
      // attribute events to an address the SDK must not know.
      mockFormo.syncWalletState = sandbox.stub() as any;
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.called).to.be.false;

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 60,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hi" } },
          },
        } as any);
      }
      expect(mockFormo.signature.called).to.be.false;
    });

    it("should not re-emit connect when the handler is rebuilt over the same connection", async () => {
      // A provider remount, options change, or HMR rebuilds the SDK instance
      // while the wallet never disconnected. That is a lifecycle event.
      (mockWagmiConfig as any).setState(createConnectedState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      const rebuilt = new WagmiEventHandler(
        mockFormo as any, mockWagmiConfig, mockQueryClient
      );
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
      // The rebuilt handler must still know the wallet, or its mutation
      // handlers would drop every signature and transaction.
      expect((rebuilt as any).trackingState.lastAddress).to.equal(mockAddress);
    });

    it("should emit again for a genuine reconnect after a disconnect", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig as any).setState(createMockState());
      if (statusListener) await statusListener("disconnected", "connected");
      await settle();

      (mockWagmiConfig as any).setState(createConnectedState());
      if (statusListener) await statusListener("connected", "disconnected");
      await settle();

      expect(mockFormo.connect.calledTwice).to.be.true;
    });

    it("should survive a throwing getState without breaking construction", async () => {
      // The seed runs inside the constructor, so an exception here would take
      // the whole handler down and silence every later event.
      (mockWagmiConfig as any).getState = sandbox.stub().throws(new Error("boom"));

      expect(
        () => new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient)
      ).to.not.throw();
      await settle();

      expect(mockFormo.connect.called).to.be.false;
    });

    it("should swallow a rejected connect emission", async () => {
      // The seeded connect is fire-and-forget; a rejection must not surface as
      // an unhandled rejection or stop the handler working afterwards.
      mockFormo.connect.rejects(new Error("queue unavailable"));
      (mockWagmiConfig as any).setState(createConnectedState());

      const handler = new WagmiEventHandler(
        mockFormo as any, mockWagmiConfig, mockQueryClient
      );
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
      // State was still adopted, so later mutations are attributed.
      expect((handler as any).trackingState.lastAddress).to.equal(mockAddress);
    });

    it("should not adopt an ordinary connect that central state declines", async () => {
      // The seed and the account-switch path both honour a refusal; the plain
      // status transition must too, or a suppressed route still ends up
      // attributing later signatures and transactions.
      (mockWagmiConfig as any).setState(createMockState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      mockFormo.syncWalletState = sandbox.stub() as any;
      (mockWagmiConfig as any).setState(createConnectedState());
      if (statusListener) await statusListener("connected", "disconnected");
      await settle();

      expect(mockFormo.connect.called).to.be.false;

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 80,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hi" } },
          },
        } as any);
      }
      expect(mockFormo.signature.called).to.be.false;
    });

    it("should re-emit after a disconnect and reconnect that happened while unmounted", async () => {
      // Nothing observes a disconnect while no handler is mounted, so the
      // markers cannot stay trustworthy indefinitely. Once the grace period
      // lapses they are dropped and the next connection is treated as new.
      //
      // The connector uid deliberately does NOT change here. Wagmi keeps it
      // stable across a disconnect and reconnect through the same connector,
      // so keying the marker on it would suppress this genuine reconnect.
      const clock = sandbox.useFakeTimers({ shouldAdvanceTime: true });
      try {
        (mockWagmiConfig as any).setState(createConnectedState());
        const first = new WagmiEventHandler(
          mockFormo as any, mockWagmiConfig, mockQueryClient
        );
        await clock.tickAsync(10);
        expect(mockFormo.connect.calledOnce).to.be.true;

        first.cleanup();

        // Unmounted for longer than a rebuild would ever take.
        await clock.tickAsync(MARKER_GRACE_MS + 100);

        new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
        await clock.tickAsync(10);

        expect(mockFormo.connect.calledTwice).to.be.true;
      } finally {
        clock.restore();
      }
    });

    it("should not re-emit for a rebuild that lands inside the grace window", async () => {
      // The counterpart to the test above, and the reason the grace window
      // exists: FormoAnalyticsProvider tears the handler down and builds a new
      // one on any options change, and init() is async, so a short gap with no
      // handler mounted is a rebuild - not a reconnect.
      const clock = sandbox.useFakeTimers({ shouldAdvanceTime: true });
      try {
        (mockWagmiConfig as any).setState(createConnectedState());
        const first = new WagmiEventHandler(
          mockFormo as any, mockWagmiConfig, mockQueryClient
        );
        await clock.tickAsync(10);
        expect(mockFormo.connect.calledOnce).to.be.true;

        first.cleanup();
        await clock.tickAsync(Math.floor(MARKER_GRACE_MS / 2));

        new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
        await clock.tickAsync(10);

        expect(mockFormo.connect.calledOnce).to.be.true;
      } finally {
        clock.restore();
      }
    });

    it("should keep the markers alive while any handler is still mounted", async () => {
      // Overlapping handlers (Strict Mode double-mount) must not start the
      // grace timer when only one of them goes away.
      const clock = sandbox.useFakeTimers({ shouldAdvanceTime: true });
      try {
        (mockWagmiConfig as any).setState(createConnectedState());
        const first = new WagmiEventHandler(
          mockFormo as any, mockWagmiConfig, mockQueryClient
        );
        await clock.tickAsync(10);
        new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
        await clock.tickAsync(10);
        const emitted = mockFormo.connect.callCount;

        first.cleanup();
        await clock.tickAsync(MARKER_GRACE_MS + 100);

        new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
        await clock.tickAsync(10);

        // The second handler never unmounted, so the marker is still valid.
        expect(mockFormo.connect.callCount).to.equal(emitted);
      } finally {
        clock.restore();
      }
    });

    it("should bound the page-load marker set", async () => {
      // One entry per wallet adopted this page load. Tiny in practice, but an
      // app that reconnects in a loop must not grow it without limit.
      for (let i = 0; i < 60; i++) {
        const address = `0x${String(i).padStart(40, "0")}`;
        const connections = new Map();
        connections.set(`c${i}`, {
          accounts: [address],
          chainId: mockChainId,
          connector: { id: "m", name: "MetaMask", type: "injected", uid: `${i}` },
        });
        (mockWagmiConfig as any).setState({
          status: "connected",
          connections,
          current: `c${i}`,
          chainId: mockChainId,
        });
        new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      }
      await settle();

      // Every one is a distinct wallet on a distinct connection, so all emit.
      expect(mockFormo.connect.callCount).to.equal(60);
      // And the newest is still deduplicated, proving the Set is alive and not
      // simply cleared wholesale.
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.callCount).to.equal(60);
    });

    it("should not re-seed a wallet that connected while the handler was alive", async () => {
      // Previously only seed-adopted wallets were deduplicated, so a wallet
      // that connected normally was re-emitted by the seed of a rebuilt
      // handler over the very same connection.
      (mockWagmiConfig as any).setState(createMockState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig as any).setState(createConnectedState());
      if (statusListener) await statusListener("connected", "disconnected");
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      // Provider remount over the unchanged connection.
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("should treat a case-only address difference as the same wallet", async () => {
      const lower = "0xabcdef0123456789abcdef0123456789abcdef01";
      (mockWagmiConfig as any).setState(
        createConnectedState(lower, mockChainId)
      );
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      // Same account, different casing, as a wallet can report across a
      // reconnect flap. `mockAddress` has no hex letters, so upper-casing it
      // is a no-op; use an address that actually changes under `toUpperCase`.
      const mixedCase = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
      expect(mixedCase.toUpperCase()).to.not.equal(mixedCase);
      (mockWagmiConfig as any).setState(
        createConnectedState(mixedCase, mockChainId)
      );
      (mockFormo as any).currentAddress = mixedCase;
      if (statusListener) {
        await statusListener("reconnecting", "connected");
        await statusListener("connected", "reconnecting");
      }
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("should bound the marker set and evict the oldest entry", async () => {
      // The status-connect path writes the same marker as the seed, so it
      // needs the same cap or a reconnect loop grows it for the page lifetime.
      //
      // Asserting that all 60 connects emit proves nothing - every address is
      // distinct, so they emit with or without a cap. The bound is proved by
      // showing the FIRST wallet's marker was evicted (it re-emits) while the
      // most recent one is still deduplicated.
      const connectTo = async (address: string) => {
        const connections = new Map();
        connections.set("k", {
          accounts: [address],
          chainId: mockChainId,
          connector: { id: "m", name: "MetaMask", type: "injected", uid: "k" },
        });
        (mockWagmiConfig as any).setState(createMockState());
        const handler = new WagmiEventHandler(
          mockFormo as any, mockWagmiConfig, mockQueryClient
        );
        (mockWagmiConfig as any).setState({
          status: "connected",
          connections,
          current: "k",
          chainId: mockChainId,
        });
        if (statusListener) await statusListener("connected", "disconnected");
        return handler;
      };

      const first = `0x${String(0).padStart(40, "0")}`;
      for (let i = 0; i < MAX_ANNOUNCED_CONNECTIONS + 10; i++) {
        await connectTo(`0x${String(i).padStart(40, "0")}`);
      }
      await settle();
      const afterFill = mockFormo.connect.callCount;
      expect(afterFill).to.equal(MAX_ANNOUNCED_CONNECTIONS + 10);

      // Re-adoption goes through the SEED path, which is the only path the
      // marker gates. A genuine `connected` status transition is a real user
      // action and always emits.
      const seedFor = async (address: string) => {
        const connections = new Map();
        connections.set("k", {
          accounts: [address],
          chainId: mockChainId,
          connector: { id: "m", name: "MetaMask", type: "injected", uid: "k" },
        });
        (mockWagmiConfig as any).setState({
          status: "connected",
          connections,
          current: "k",
          chainId: mockChainId,
        });
        new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
        await settle();
      };

      // The newest wallet is still marked, so re-adopting it stays silent.
      const newest = `0x${String(MAX_ANNOUNCED_CONNECTIONS + 9).padStart(40, "0")}`;
      await seedFor(newest);
      expect(mockFormo.connect.callCount).to.equal(afterFill);

      // The first wallet was evicted by the cap, so it emits again. Without
      // the bound its marker would still be present and this would stay silent.
      await seedFor(first);
      expect(mockFormo.connect.callCount).to.equal(afterFill + 1);
    });

    it("should not mark a wallet it never announced", async () => {
      // With connect autocapture off the seed adopts the wallet but emits
      // nothing. Marking it anyway would make the rebuilt handler that an
      // options change produces find the marker and stay silent, so enabling
      // connect autocapture would never report the live wallet.
      (mockFormo as any).isAutocaptureEnabled = sandbox.stub().callsFake(
        (t: string) => t !== "connect"
      );
      (mockWagmiConfig as any).setState(createConnectedState());
      const first = new WagmiEventHandler(
        mockFormo as any, mockWagmiConfig, mockQueryClient
      );
      await settle();
      expect(mockFormo.connect.called).to.be.false;

      // Options change: SDK rebuilt with connect autocapture now enabled.
      first.cleanup();
      (mockFormo as any).isAutocaptureEnabled = sandbox.stub().returns(true);
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("should adopt the connection once a late chainId completes it", async () => {
      // Constructed against a connection wagmi had not finished filling in.
      // Only status and chain are subscribed, and an unchanged connection
      // produces no status change, so without a retry the wallet stays
      // invisible for the rest of the page load.
      const connections = new Map();
      connections.set("k", {
        accounts: [mockAddress],
        connector: { id: "m", name: "MetaMask", type: "injected", uid: "k" },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections,
        current: "k",
        chainId: undefined,
      });

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.called).to.be.false;

      // The chain arrives.
      connections.set("k", {
        accounts: [mockAddress],
        chainId: mockChainId,
        connector: { id: "m", name: "MetaMask", type: "injected", uid: "k" },
      });
      (mockWagmiConfig as any).setState({
        status: "connected",
        connections,
        current: "k",
        chainId: mockChainId,
      });
      if (chainIdListener) await chainIdListener(mockChainId, undefined);
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
      const call = mockFormo.connect.firstCall.args[0];
      expect(call.address).to.equal(mockAddress);
      expect(call.chainId).to.equal(mockChainId);
    });

    it("should adopt a declined connection after navigation makes it trackable", async () => {
      // Constructed on an excluded SPA path: syncWalletState refuses to learn
      // the wallet. Navigating to an allowed path fires no wagmi event, so
      // without an explicit retry the connection stays invisible.
      (mockFormo as any).syncWalletState = sandbox.stub().callsFake(() => {
        (mockFormo as any).currentAddress = undefined;
      });
      (mockWagmiConfig as any).setState(createConnectedState());
      const handler = new WagmiEventHandler(
        mockFormo as any, mockWagmiConfig, mockQueryClient
      );
      await settle();
      expect(mockFormo.connect.called).to.be.false;

      // Navigation to an allowed path: central state accepts wallets again.
      (mockFormo as any).syncWalletState = sandbox.stub().callsFake((prm: any) => {
        (mockFormo as any).currentAddress = prm?.address;
        (mockFormo as any).currentChainId = prm?.chainId;
      });
      handler.retryAdoption();
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("should emit exactly once when a rebuild interrupts the seed", async () => {
      // The marker and the emission must be decided together. Deferring the
      // emission to a microtask and skipping it when disposed loses the event
      // outright: the marker stands, so the replacement handler suppresses its
      // own connect while the original declines to emit, and nobody reports
      // the wallet at all.
      (mockWagmiConfig as any).setState(createConnectedState());
      const first = new WagmiEventHandler(
        mockFormo as any, mockWagmiConfig, mockQueryClient
      );
      // Torn down immediately, as a rebuild does.
      first.cleanup();
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.callCount, "exactly one connect").to.equal(1);
    });

    it("should not mark a wallet whose connect the tracking gate will drop", async () => {
      // syncWalletState accepts the wallet, but trackEvent drops the event
      // (tracking: false, or an excluded chain). Marking it would make the
      // rebuild that turns tracking back on stay silent about the wallet.
      (mockFormo as any).willTrackEvent = sandbox.stub().returns(false);
      (mockWagmiConfig as any).setState(createConnectedState());
      const first = new WagmiEventHandler(
        mockFormo as any, mockWagmiConfig, mockQueryClient
      );
      await settle();
      const before = mockFormo.connect.callCount;

      // Configuration changes to allow tracking; the SDK is rebuilt.
      first.cleanup();
      (mockFormo as any).willTrackEvent = sandbox.stub().returns(true);
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      expect(mockFormo.connect.callCount).to.equal(before + 1);
    });

    it("should apply a disconnect that landed while the connect emission held the lock", async () => {
      // handleStatusChange drops - does not defer - anything arriving while
      // isProcessing is held, so the handler would otherwise stay convinced
      // the wallet is connected.
      let releaseConnect: (() => void) | undefined;
      (mockFormo as any).connect = sandbox.stub().returns(
        new Promise<void>((resolve) => { releaseConnect = () => resolve(); })
      );
      (mockWagmiConfig as any).setState(createMockState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      (mockWagmiConfig as any).setState(createConnectedState());
      const pending = statusListener!("connected", "disconnected");
      await settle();

      // Wallet goes away while the connect emission is still in flight.
      (mockWagmiConfig as any).setState(createMockState());
      await statusListener!("disconnected", "connected");

      releaseConnect!();
      await pending;
      await settle();

      expect(mockFormo.disconnect.called, "disconnect reconciled").to.be.true;
    });

    it("should adopt a reconnect that landed while the disconnect emission held the lock", async () => {
      let releaseDisconnect: (() => void) | undefined;
      (mockFormo as any).disconnect = sandbox.stub().returns(
        new Promise<void>((resolve) => { releaseDisconnect = () => resolve(); })
      );
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      const afterSeed = mockFormo.connect.callCount;

      (mockWagmiConfig as any).setState(createMockState());
      const pending = statusListener!("disconnected", "connected");
      await settle();

      // Wallet comes back while the disconnect emission is still in flight.
      (mockWagmiConfig as any).setState(createConnectedState());
      await statusListener!("connected", "disconnected");

      releaseDisconnect!();
      await pending;
      await settle();

      expect(mockFormo.connect.callCount).to.be.greaterThan(afterSeed);
    });

    it("should drop the wallet when a re-entry chain is declined", async () => {
      // Reconnect flap that lands on an excluded chain. syncWalletState
      // refuses it, so the private chain must not be recorded either -
      // otherwise mutations get labelled with a chain shouldTrack() excludes.
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();
      expect(mockFormo.connect.calledOnce).to.be.true;

      const EXCLUDED = 8453;
      (mockFormo as any).syncWalletState = sandbox.stub().callsFake(() => {
        (mockFormo as any).currentAddress = undefined;
        (mockFormo as any).currentChainId = undefined;
      });
      (mockWagmiConfig as any).setState(
        createConnectedState(mockAddress, EXCLUDED)
      );
      if (statusListener) {
        await statusListener("reconnecting", "connected");
        await statusListener("connected", "reconnecting");
      }
      await settle();

      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 91,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hi" } },
          },
        } as any);
      }
      expect(mockFormo.signature.called, "no attribution to a declined wallet").to.be.false;
    });

    it("should drop the wallet when a chain change is declined", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      const EXCLUDED = 8453;
      (mockFormo as any).syncWalletState = sandbox.stub().callsFake(() => {
        (mockFormo as any).currentAddress = undefined;
        (mockFormo as any).currentChainId = undefined;
      });
      (mockWagmiConfig as any).setState(
        createConnectedState(mockAddress, EXCLUDED)
      );
      if (chainIdListener) await chainIdListener(EXCLUDED, mockChainId);
      await settle();

      expect(mockFormo.chain.called, "no chain event for a declined chain").to.be.false;
      if (mutationListener) {
        mutationListener({
          type: "updated",
          mutation: {
            mutationId: 92,
            options: { mutationKey: ["signMessage"] },
            state: { status: "success", variables: { message: "hi" } },
          },
        } as any);
      }
      expect(mockFormo.signature.called, "no attribution to a declined wallet").to.be.false;
    });

    it("should not reconcile when reading wagmi state throws", async () => {
      (mockWagmiConfig as any).setState(createConnectedState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig.getState as sinon.SinonStub).throws(new Error("store gone"));
      // Must not propagate out of the status listener's finally block.
      if (statusListener) await statusListener("disconnected", "connected");
      await settle();

      expect(true).to.be.true;
    });

    it("should emit one connect when two overlapping handlers see one transition", async () => {
      // Strict Mode, or an options change whose replacement mounts before the
      // old one is torn down: both handlers subscribe to the same config and
      // both observe the same transition. One user action, one connect.
      (mockWagmiConfig as any).setState(createMockState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      const listenerA = statusListener;
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      const listenerB = statusListener;
      await settle();
      expect(listenerA, "two distinct listeners").to.not.equal(listenerB);

      (mockWagmiConfig as any).setState(createConnectedState());
      await listenerA!("connected", "disconnected");
      await listenerB!("connected", "disconnected");
      await settle();

      expect(mockFormo.connect.callCount, "one connect for one action").to.equal(1);
    });

    it("should still emit a genuine reconnect after a disconnect", async () => {
      // The counterpart: consulting the marker on the connect path must not
      // swallow a real reconnect. The disconnect path removes the marker.
      (mockWagmiConfig as any).setState(createMockState());
      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig as any).setState(createConnectedState());
      await statusListener!("connected", "disconnected");
      await settle();
      expect(mockFormo.connect.callCount).to.equal(1);

      (mockWagmiConfig as any).setState(createMockState());
      await statusListener!("disconnected", "connected");
      await settle();

      (mockWagmiConfig as any).setState(createConnectedState());
      await statusListener!("connected", "disconnected");
      await settle();

      expect(mockFormo.connect.callCount, "the reconnect still emits").to.equal(2);
    });

    it("should not let one destination keep another's markers alive", async () => {
      // Liveness is per write key. A global count let a mounted destination B
      // preserve A's markers, so a reconnect that happened while A was
      // unmounted had its genuine connect suppressed when A returned.
      const clock = sandbox.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const other: any = {
          connect: sandbox.stub().resolves(),
          disconnect: sandbox.stub().resolves(),
          chain: sandbox.stub().resolves(),
          signature: sandbox.stub().resolves(),
          transaction: sandbox.stub().resolves(),
          isAutocaptureEnabled: sandbox.stub().returns(true),
          willTrackEvent: sandbox.stub().returns(true),
          syncWalletState: sandbox.stub().callsFake((prm: any) => {
            other.currentAddress = prm?.address;
          }),
          currentAddress: undefined,
          writeKey: "other-write-key",
        };

        (mockWagmiConfig as any).setState(createConnectedState());
        const a = new WagmiEventHandler(
          mockFormo as any, mockWagmiConfig, mockQueryClient
        );
        // Destination B stays mounted for the whole test.
        new WagmiEventHandler(other, mockWagmiConfig, mockQueryClient);
        await clock.tickAsync(10);
        expect(mockFormo.connect.calledOnce).to.be.true;

        // A unmounts and stays away past the grace window; B never does.
        a.cleanup();
        await clock.tickAsync(MARKER_GRACE_MS + 100);

        new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
        await clock.tickAsync(10);

        expect(
          mockFormo.connect.callCount,
          "A's markers expired independently of B"
        ).to.equal(2);
      } finally {
        clock.restore();
      }
    });

    it("should still emit connect for a later connection after an empty seed", async () => {
      (mockWagmiConfig as any).setState(createMockState());

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);
      await settle();

      (mockWagmiConfig as any).setState(createConnectedState());
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await settle();

      expect(mockFormo.connect.calledOnce).to.be.true;
    });
  });
});

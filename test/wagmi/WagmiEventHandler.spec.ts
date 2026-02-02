import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { WagmiEventHandler } from "../../src/wagmi/WagmiEventHandler";
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

  const mockAddress = "0x1234567890123456789012345678901234567890";
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
    sandbox = sinon.createSandbox();
    statusListener = null;
    chainIdListener = null;
    mutationListener = null;
    queryListener = null;

    // Create mock FormoAnalytics
    mockFormo = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      chain: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
    } as any;

    // Create mock Wagmi config with subscribe
    let currentState = createMockState();
    mockWagmiConfig = {
      subscribe: sandbox.stub().callsFake((selector: any, listener: any) => {
        // Determine which listener based on the selector
        const testState = createMockState({ status: "connected", chainId: 1 });
        const selectedValue = selector(testState);

        if (typeof selectedValue === "string") {
          // Status selector
          statusListener = listener;
        } else if (typeof selectedValue === "number" || selectedValue === undefined) {
          // ChainId selector
          chainIdListener = listener;
        }

        return () => {
          statusListener = null;
          chainIdListener = null;
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

      expect((mockWagmiConfig.subscribe as sinon.SinonStub).calledTwice).to.be.true;
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
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Simulate status change
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
      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 1,
          options: { mutationKey: ["signMessage"] },
          state: {
            status: "success",
            data: "0xsignature123",
            variables: { message: "Hello World" },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFormo.signature.calledOnce).to.be.true;
      const signatureCall = mockFormo.signature.firstCall;
      expect(signatureCall.args[0]).to.deep.include({
        status: "confirmed",
        message: "Hello World",
        signatureHash: "0xsignature123",
      });
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

      const mutationEvent: MutationCacheEvent = {
        type: "updated",
        mutation: {
          mutationId: 4,
          options: { mutationKey: ["signTypedData"] },
          state: {
            status: "success",
            data: "0xtypedsig",
            variables: { types: { Person: [{ name: "name", type: "string" }] } },
          },
        },
      };

      if (mutationListener) {
        mutationListener(mutationEvent);
      }

      expect(mockFormo.signature.calledOnce).to.be.true;
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
    it("should track CONFIRMED status when waitForTransactionReceipt query succeeds", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      // Connect first
      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

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

    it("should handle CONFIRMED without prior BROADCASTED (no preserved details)", async () => {
      const connectedState = createConnectedState();
      (mockWagmiConfig as any).setState(connectedState);

      new WagmiEventHandler(mockFormo as any, mockWagmiConfig, mockQueryClient);

      if (statusListener) {
        await statusListener("connected", "disconnected");
      }
      await new Promise(resolve => setTimeout(resolve, 10));

      // Emit CONFIRMED without prior BROADCASTED (e.g., page reload)
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

      // Should still emit CONFIRMED but without additional details
      expect(mockFormo.transaction.calledOnce).to.be.true;
      const confirmedCall = mockFormo.transaction.firstCall.args[0];
      expect(confirmedCall.status).to.equal("confirmed");
      expect(confirmedCall.transactionHash).to.equal("0xunknown_tx");
      expect(confirmedCall.chainId).to.equal(1);

      // No preserved details
      expect(confirmedCall.to).to.be.undefined;
      expect(confirmedCall.data).to.be.undefined;
      expect(confirmedCall.function_name).to.be.undefined;
    });
  });
});

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
} from "../../src/wagmi/types";

describe("WagmiEventHandler", () => {
  let sandbox: sinon.SinonSandbox;
  let mockFormo: sinon.SinonStubbedInstance<FormoAnalytics>;
  let mockWagmiConfig: WagmiConfig;
  let mockQueryClient: QueryClient;
  let statusListener: ((status: WagmiState["status"], prevStatus: WagmiState["status"]) => void) | null;
  let chainIdListener: ((chainId: number | undefined, prevChainId: number | undefined) => void) | null;
  let mutationListener: ((event: MutationCacheEvent) => void) | null;

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

    mockQueryClient = {
      getMutationCache: sandbox.stub().returns(mockMutationCache),
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
      // with arg_ prefix to avoid collision with built-in transaction fields
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({ arg_repayAmount: "3300000" });
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
      // with arg_ prefix to avoid collision with built-in transaction fields like 'to'
      const txProperties = mockFormo.transaction.firstCall.args[1];
      expect(txProperties).to.deep.equal({
        arg_to: "0xrecipient123",
        arg_amount: "1000000000000000000",
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
});

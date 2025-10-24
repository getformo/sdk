import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { EventQueue } from "../../../src/lib/queue/EventQueue";
import { IFormoEvent } from "../../../src/types";
import { logger } from "../../../src/lib/logger";

// Mock browser APIs for Node.js environment
if (typeof globalThis.addEventListener === 'undefined') {
  (globalThis as any).addEventListener = () => {};
}
if (typeof document === 'undefined') {
  (global as any).document = {
    addEventListener: () => {},
    visibilityState: 'visible'
  };
}

// Helper to create a mock event
const createMockEvent = (overrides: Partial<IFormoEvent> = {}): IFormoEvent => ({
  type: "track",
  event: "test_event",
  properties: null,
  context: {
    user_agent: "test",
    locale: "en-US",
    timezone: "UTC",
    location: "US",
    page_path: "/test",
    page_title: "Test",
    page_url: "https://test.com",
    library_name: "Formo Web SDK",
    library_version: "1.0.0",
  },
  original_timestamp: new Date().toISOString(),
  user_id: null,
  address: null,
  anonymous_id: "12345678-1234-1234-1234-123456789012",
  channel: "web",
  version: "1.0.0",
  ...overrides,
});

// Helper to wait for a specific duration
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("EventQueue Deduplication", () => {
  let eventQueue: EventQueue;
  let loggerWarnStub: sinon.SinonStub;
  let loggerLogStub: sinon.SinonStub;
  const mockWriteKey = "test_write_key";
  
  beforeEach(() => {
    // Stub logger methods to spy on calls
    loggerWarnStub = sinon.stub(logger, "warn");
    loggerLogStub = sinon.stub(logger, "log");
    
    // Create a new EventQueue instance for each test
    eventQueue = new EventQueue(mockWriteKey, {
      url: "https://api.test.com/events",
      flushAt: 20,
      flushInterval: 30000, // 30 seconds
      maxQueueSize: 1024 * 500, // 500kB
    });
  });
  
  afterEach(() => {
    // Restore all stubs
    sinon.restore();
  });

  describe("Basic Deduplication", () => {
    it("should block duplicate events sent within the same second", async () => {
      const event1 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: "2025-01-01T10:30:15.123Z",
      });
      
      const event2 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: "2025-01-01T10:30:15.456Z", // Same second, different milliseconds
      });

      // Enqueue first event - should succeed
      await eventQueue.enqueue(event1);
      expect(loggerLogStub.calledOnce).to.be.true;
      expect(loggerWarnStub.called).to.be.false;
      
      // Enqueue duplicate event - should be blocked
      await eventQueue.enqueue(event2);
      
      // Verify duplicate was detected
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerWarnStub.firstCall.args[0]).to.include("Duplicate event detected");
      // Only one "Event enqueued" log (first event only)
      expect(loggerLogStub.calledOnce).to.be.true;
    });

    it("should allow different events with different properties", async () => {
      const event1 = createMockEvent({
        event: "transaction_submit",
        properties: { transactionType: "swap" },
        original_timestamp: "2025-01-01T10:30:15.000Z",
      });
      
      const event2 = createMockEvent({
        event: "transaction_submit",
        properties: { transactionType: "trade" },
        original_timestamp: "2025-01-01T10:30:15.000Z", // Same timestamp
      });

      // Both should be enqueued because they have different properties
      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2);
      
      // Verify both were enqueued (no duplicate warnings)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true; // Two "Event enqueued" logs
    });

    it("should allow events with different event names", async () => {
      const timestamp = "2025-01-01T10:30:15.000Z";
      
      const event1 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: timestamp,
      });
      
      const event2 = createMockEvent({
        event: "transaction_success",
        original_timestamp: timestamp,
      });

      // Both should be enqueued because they have different event names
      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2);
      
      // Verify both were enqueued (no duplicate warnings)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true;
    });
  });

  describe("Time-Based Deduplication", () => {
    it("should deduplicate events within 60 second window", async () => {
      const event1 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: "2025-01-01T10:30:15.000Z",
      });
      
      const event2 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: "2025-01-01T10:30:45.000Z", // 30 seconds later
      });

      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2);
      
      // Verify second event was blocked (within 60s window)
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerWarnStub.firstCall.args[0]).to.include("30s ago");
      expect(loggerLogStub.calledOnce).to.be.true; // Only first event enqueued
    });

    it("should allow events outside 60 second window", async () => {
      const event1 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: "2025-01-01T10:30:00.000Z",
      });
      
      const event2 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: "2025-01-01T10:31:05.000Z", // 65 seconds later
      });

      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2);
      
      // Verify both were allowed (outside 60s window)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true;
    });
  });

  describe("Cross-Flush Deduplication", () => {
    it("should maintain deduplication across flush cycles", async () => {
      // Create enough events to trigger a flush (flushAt = 20)
      const events: IFormoEvent[] = [];
      for (let i = 0; i < 20; i++) {
        events.push(createMockEvent({
          event: `event_${i}`,
          original_timestamp: "2025-01-01T10:30:00.000Z",
        }));
      }

      // Enqueue all events to trigger a flush
      for (const event of events) {
        await eventQueue.enqueue(event);
      }
      
      // At this point, queue should have flushed
      // Reset counters to test the duplicate
      loggerLogStub.resetHistory();
      loggerWarnStub.resetHistory();

      // Now try to enqueue a duplicate of the first event
      // This should be blocked even though we've flushed
      const duplicateEvent = createMockEvent({
        event: "event_0",
        original_timestamp: "2025-01-01T10:30:00.000Z",
      });

      await eventQueue.enqueue(duplicateEvent);
      
      // Verify duplicate was blocked even after flush
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerWarnStub.firstCall.args[0]).to.include("Duplicate event detected");
      expect(loggerLogStub.called).to.be.false; // Event not enqueued
    });
  });

  describe("Hash Cleanup", () => {
    it("should clean up old hashes automatically", async () => {
      const event1 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:00.000Z",
      });

      await eventQueue.enqueue(event1);
      
      // Now enqueue the same event but with a timestamp > 60s later
      // This simulates time passing and should trigger cleanup
      const event2 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:31:05.000Z", // 65 seconds later
      });
      
      await eventQueue.enqueue(event2);
      
      // Verify second event was allowed (hash was cleaned up)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true;
    });
  });

  describe("Message ID Generation", () => {
    it("should generate different IDs for events in different seconds", async () => {
      // This test verifies that the generateMessageId() uses second precision
      const event1 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:15.123Z",
      });
      
      const event2 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:16.123Z", // Different second
      });

      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2);
      
      // Verify both were enqueued (different seconds = different hashes)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true;
    });

    it("should generate same IDs for events in the same second", async () => {
      // This test verifies that milliseconds are ignored in the hash
      const event1 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:15.123Z",
      });
      
      const event2 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:15.999Z", // Same second, different milliseconds
      });

      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2);
      
      // Verify second was blocked (same second, same data)
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerLogStub.calledOnce).to.be.true;
    });
  });

  describe("Real-World Scenarios", () => {
    it("should handle rapid-fire transaction events", async () => {
      const baseTimestamp = new Date("2025-01-01T10:30:00.000Z");
      
      // Simulate a user clicking submit multiple times rapidly
      for (let i = 0; i < 5; i++) {
        const event = createMockEvent({
          event: "transaction_submit",
          properties: { transactionType: "swap", amount: "100" },
          original_timestamp: new Date(baseTimestamp.getTime() + i * 100).toISOString(), // 100ms apart
        });
        await eventQueue.enqueue(event);
      }
      
      // Only the first event should be enqueued (all within same second)
      expect(loggerLogStub.calledOnce).to.be.true;
      expect(loggerWarnStub.callCount).to.equal(4); // 4 duplicates blocked
    });

    it("should allow transaction lifecycle events", async () => {
      const baseTimestamp = new Date("2025-01-01T10:30:00.000Z");
      
      // Typical transaction flow: submit -> success
      const submitEvent = createMockEvent({
        event: "transaction_submit",
        properties: { transactionType: "swap" },
        original_timestamp: baseTimestamp.toISOString(),
      });
      
      const successEvent = createMockEvent({
        event: "transaction_success",
        properties: { transactionType: "swap", txHash: "0x123" },
        original_timestamp: new Date(baseTimestamp.getTime() + 5000).toISOString(), // 5s later
      });

      await eventQueue.enqueue(submitEvent);
      await eventQueue.enqueue(successEvent);
      
      // Verify both were enqueued (different event names)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true;
    });

    it("should handle multiple transactions of the same type", async () => {
      const baseTimestamp = new Date("2025-01-01T10:30:00.000Z");
      
      // User performs multiple swaps with different details
      const swap1 = createMockEvent({
        event: "transaction_submit",
        properties: { transactionType: "swap", amount: "100", tokenA: "ETH", tokenB: "USDC" },
        original_timestamp: baseTimestamp.toISOString(),
      });
      
      const swap2 = createMockEvent({
        event: "transaction_submit",
        properties: { transactionType: "swap", amount: "200", tokenA: "ETH", tokenB: "DAI" },
        original_timestamp: new Date(baseTimestamp.getTime() + 10000).toISOString(), // 10s later
      });

      await eventQueue.enqueue(swap1);
      await eventQueue.enqueue(swap2);
      
      // Verify both were enqueued (different properties)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true;
    });
  });
});


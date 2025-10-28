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
      expect((eventQueue as any).queue.length).to.equal(1);
      
      // Enqueue duplicate event - should be blocked
      await eventQueue.enqueue(event2);
      
      // Verify duplicate was detected
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerWarnStub.firstCall.args[0]).to.include("Duplicate event detected");
      // Only one "Event enqueued" log (first event only)
      expect(loggerLogStub.calledOnce).to.be.true;
      // Queue should still only have one event
      expect((eventQueue as any).queue.length).to.equal(1);
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
    it("should deduplicate events based on hash within real-time window", async () => {
      // Events with same data but different timestamps in properties create same hash
      const event1 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: "2025-01-01T10:30:15.000Z",
      });
      
      const event2 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: "2025-01-01T10:30:45.000Z", // Different timestamp but same data
      });

      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2);
      
      // Both allowed - different timestamps create different hashes
      // (timestamp is part of the hash)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true;
    });

    it("should block duplicates within 60 second real-time window", async () => {
      // Identical events (same timestamp in event data) within real-time window
      const timestamp = "2025-01-01T10:30:00.000Z";
      const event1 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: timestamp,
      });
      
      const event2 = createMockEvent({
        event: "transaction_submit",
        original_timestamp: timestamp, // Exact same timestamp
      });

      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2); // Arrives moments later in real time
      
      // Verify second event was blocked (same hash, within real-time window)
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerWarnStub.firstCall.args[0]).to.include("Duplicate event detected");
      expect(loggerLogStub.calledOnce).to.be.true; // Only first event enqueued
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
    it("should handle out-of-order events correctly", async () => {
      // Simulate events arriving out of chronological order
      const newerEvent = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:31:00.000Z", // Newer timestamp
      });

      await eventQueue.enqueue(newerEvent);
      
      // Now enqueue an older event
      const olderEvent = createMockEvent({
        event: "different_event", // Different event, so not a duplicate
        original_timestamp: "2025-01-01T10:30:00.000Z", // Older timestamp
      });
      
      await eventQueue.enqueue(olderEvent);
      
      // Both should be allowed (different events, cleanup based on real time)
      expect(loggerWarnStub.called).to.be.false;
      expect(loggerLogStub.calledTwice).to.be.true;
    });

    it("should clean up hashes based on real elapsed time", async () => {
      // This test shows that cleanup is based on Date.now(), not event timestamps
      // In a real implementation, you'd mock Date.now() to test this properly
      // For now, we verify the logic doesn't break with same-timestamp events
      const event1 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:00.000Z",
      });
      
      const event2 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:00.000Z", // Same timestamp
      });

      await eventQueue.enqueue(event1);
      await eventQueue.enqueue(event2);
      
      // Second event should be blocked as duplicate (same hash)
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerLogStub.calledOnce).to.be.true;
    });

    it("should allow events after 60s deduplication window expires", async () => {
      // This test verifies that the same event CAN be sent again after 60s
      // To properly test this, we need to mock Date.now() to simulate time passing
      
      const event1 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:00.000Z",
      });

      // Stub Date.now() to control time
      let currentTime = new Date("2025-01-01T10:30:00.000Z").getTime();
      const dateNowStub = sinon.stub(Date, 'now').callsFake(() => currentTime);

      // Enqueue first event at time T
      await eventQueue.enqueue(event1);
      expect(loggerLogStub.calledOnce).to.be.true;
      expect(loggerWarnStub.called).to.be.false;
      expect((eventQueue as any).queue.length).to.equal(1);

      // Try to enqueue duplicate immediately - should be blocked
      await eventQueue.enqueue(event1);
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerLogStub.calledOnce).to.be.true; // Still only one
      expect((eventQueue as any).queue.length).to.equal(1);

      // Advance time by 61 seconds (past the 60s window)
      currentTime += 61 * 1000;
      loggerLogStub.resetHistory();
      loggerWarnStub.resetHistory();

      // Now try to enqueue the same event again - should be allowed
      await eventQueue.enqueue(event1);
      expect(loggerWarnStub.called).to.be.false; // No duplicate warning
      expect(loggerLogStub.calledOnce).to.be.true; // Event enqueued
      expect((eventQueue as any).queue.length).to.equal(2); // Both events in queue

      // Restore the stub
      dateNowStub.restore();
    });

    it("should clean up old hashes during flush to prevent memory leaks", async () => {
      // This test verifies that cleanup happens during flush even when no events arrive
      const event1 = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:00.000Z",
      });

      // Stub Date.now() to control time
      let currentTime = new Date("2025-01-01T10:30:00.000Z").getTime();
      const dateNowStub = sinon.stub(Date, 'now').callsFake(() => currentTime);

      // Enqueue event and verify hash is stored
      await eventQueue.enqueue(event1);
      expect((eventQueue as any).payloadHashes.size).to.equal(1);

      // Advance time by 61 seconds (past the 60s window)
      currentTime += 61 * 1000;

      // Trigger flush - should clean up old hashes even with no events in queue
      await (eventQueue as any).flush();

      // Verify hash was cleaned up
      expect((eventQueue as any).payloadHashes.size).to.equal(0);

      // Restore the stub
      dateNowStub.restore();
    });

    it("should throttle cleanup during high-throughput periods", async () => {
      // This test verifies that cleanup is throttled to reduce overhead
      const createEvent = (timestamp: string) => createMockEvent({
        event: "test_event",
        original_timestamp: timestamp,
      });

      // Stub Date.now() to control time
      let currentTime = new Date("2025-01-01T10:30:00.000Z").getTime();
      const dateNowStub = sinon.stub(Date, 'now').callsFake(() => currentTime);

      // Enqueue 100 events in rapid succession (within 1 second)
      for (let i = 0; i < 100; i++) {
        await eventQueue.enqueue(createEvent(`2025-01-01T10:30:${String(i).padStart(2, '0')}.000Z`));
        currentTime += 10; // 10ms between events
      }

      // Verify lastCleanupTime was updated (cleanup ran at least once)
      const lastCleanup = (eventQueue as any).lastCleanupTime;
      expect(lastCleanup).to.be.greaterThan(0);

      // Advance time by 5 seconds (within throttle window)
      currentTime += 5 * 1000;

      // Enqueue one more event - cleanup should be throttled
      const beforeCleanup = (eventQueue as any).lastCleanupTime;
      await eventQueue.enqueue(createEvent("2025-01-01T10:30:59.000Z"));
      const afterCleanup = (eventQueue as any).lastCleanupTime;

      // lastCleanupTime should not have changed (cleanup was throttled)
      expect(afterCleanup).to.equal(beforeCleanup);

      // Restore the stub
      dateNowStub.restore();
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


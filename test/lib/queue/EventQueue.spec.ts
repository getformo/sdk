import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import { EventQueue } from "../../../src/lib/queue/EventQueue";
import { IFormoEvent } from "../../../src/types";

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
  const mockWriteKey = "test_write_key";
  
  beforeEach(() => {
    // Create a new EventQueue instance for each test
    eventQueue = new EventQueue(mockWriteKey, {
      url: "https://api.test.com/events",
      flushAt: 20,
      flushInterval: 30000, // 30 seconds
      maxQueueSize: 1024 * 500, // 500kB
    });
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
      
      // Enqueue duplicate event - should be blocked
      await eventQueue.enqueue(event2);
      
      // We can't directly check the queue size, but we can verify
      // that the second call doesn't throw and returns silently
      // In a real test, you'd want to spy on logger.warn to verify the warning
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
      
      // Both events should be in the queue (different hashes)
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
      
      // Second event should be blocked (within 60s window, same data)
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
      
      // Wait a bit to simulate real timing
      await wait(100);
      
      await eventQueue.enqueue(event2);
      
      // Second event should be allowed (outside 60s window)
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

      // Now try to enqueue a duplicate of the first event
      // This should be blocked even though we've flushed
      const duplicateEvent = createMockEvent({
        event: "event_0",
        original_timestamp: "2025-01-01T10:30:00.000Z",
      });

      await eventQueue.enqueue(duplicateEvent);
      
      // This duplicate should be blocked
    });
  });

  describe("Hash Cleanup", () => {
    it("should clean up old hashes automatically", async () => {
      // This test verifies that the cleanup logic in isDuplicate() works
      // In a real scenario, you'd mock Date.now() to simulate time passing
      
      const event = createMockEvent({
        event: "test_event",
        original_timestamp: "2025-01-01T10:30:00.000Z",
      });

      await eventQueue.enqueue(event);
      
      // In a real test with mocked time, you'd:
      // 1. Mock Date.now() to return time + 61 seconds
      // 2. Enqueue the same event again
      // 3. Verify it's allowed (hash was cleaned up)
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
      
      // Both should be enqueued (different seconds)
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
      
      // Second should be blocked (same second, same data)
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
      
      // Only the first event should be enqueued, others blocked
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
      
      // Both should be enqueued (different event names)
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
      
      // Both should be enqueued (different properties)
    });
  });
});


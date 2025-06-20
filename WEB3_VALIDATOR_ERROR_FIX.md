# Web3ValidatorError Fix: Null Values in Transaction Data

## Issue Summary

Customers using modern web3 libraries (wagmi v2.5.7, viem v2.7.12, Rainbow Kit v2.0.1) with the Formo SDK were experiencing the following error:

```
web3validatorError: Web3 validator found 1 error[s]: 
value "null" at "/0" must pass "bytes32" validation
```

**Key Details:**
- Error occurs during transaction approvals in the frontend
- Transactions succeed on-chain but fail in the frontend
- Prevents the Formo SDK from indexing transaction data
- Issue is specific to modern wagmi/viem stack compatibility

## Root Cause Analysis

### Primary Issue
The Formo SDK's `buildTransactionEventPayload` method was not properly handling null/undefined values in transaction parameters. Modern web3 libraries like wagmi and viem often set the `data` field to `null` for simple ETH transfers (since there's no contract interaction).

### Technical Details
1. **Null Handling**: The original code destructured transaction parameters without null checks:
   ```typescript
   const { data, from, to, value } = params[0] as {
     data: string;  // This could be null
     from: string;
     to: string;
     value: string;
   };
   ```

2. **Validation Conflict**: External validation libraries expect transaction data fields to be proper hex strings (bytes32) or undefined, but not `null`.

3. **Error Location**: The error occurred in the Formo SDK's tracking logic, not in the actual transaction execution, which is why transactions still succeeded on-chain.

## Solution Implemented

### 1. Enhanced Parameter Validation
Updated `buildTransactionEventPayload` method with proper null handling:

```typescript
private async buildTransactionEventPayload(params: unknown[]) {
  // Validate that params[0] exists and is an object
  if (!params || !params[0] || typeof params[0] !== 'object') {
    throw new Error("FormoAnalytics::buildTransactionEventPayload: Invalid transaction parameters");
  }

  const transactionParams = params[0] as {
    data?: string | null;
    from?: string;
    to?: string;
    value?: string;
  };

  // Extract and validate transaction fields with proper null handling
  const data = transactionParams.data || undefined; // Convert null to undefined for compatibility
  const from = transactionParams.from;
  const to = transactionParams.to;
  const value = transactionParams.value || "0x0"; // Default to zero value if not provided

  // Validate required fields
  if (!from) {
    throw new Error("FormoAnalytics::buildTransactionEventPayload: 'from' address is required");
  }

  return {
    chainId: this.currentChainId || (await this.getCurrentChainId()),
    data, // Now properly handles null/undefined
    address: from,
    to,
    value,
  };
}
```

### 2. Updated Type Definitions
Made transaction fields optional in the `TransactionAPIEvent` interface:

```typescript
export interface TransactionAPIEvent {
  type: "transaction";
  status: TransactionStatus;
  chainId: ChainID;
  address: Address;
  data?: string;      // Optional
  to?: string;        // Optional
  value?: string;     // Optional
  transactionHash?: string; // Optional
}
```

### 3. Enhanced Event Factory
Updated `generateTransactionEvent` to handle optional fields:

```typescript
generateTransactionEvent(
  status: TransactionStatus,
  chainId: ChainID,
  address: Address,
  data?: string,
  to?: string,
  value?: string,
  transactionHash?: string,
  properties?: IFormoEventProperties,
  context?: IFormoEventContext
) {
  const transactionEvent: Partial<IFormoEvent> = {
    properties: {
      status,
      chainId,
      ...(data !== undefined && { data }),
      ...(to !== undefined && { to }),
      ...(value !== undefined && { value }),
      ...(transactionHash !== undefined && { transactionHash }),
      ...properties,
    },
    address,
    type: "transaction",
  };

  return this.getEnrichedEvent(transactionEvent, context);
}
```

### 4. Improved Error Handling
Enhanced the transaction listener with better error handling:

```typescript
private registerTransactionListener(): void {
  // ... existing code ...
  
  let payload;
  try {
    // Track transaction start with enhanced error handling
    payload = await this.buildTransactionEventPayload(params);
    this.transaction({ status: TransactionStatus.STARTED, ...payload });
  } catch (payloadError) {
    logger.error("Error building transaction payload:", payloadError);
    // Continue with the original request even if tracking fails
    return request({ method, params });
  }

  try {
    const transactionHash = (await request({ method, params })) as string;

    // Track transaction broadcast only if we have a valid transaction hash
    if (transactionHash && typeof transactionHash === 'string') {
      this.transaction({
        status: TransactionStatus.BROADCASTED,
        ...payload,
        transactionHash,
      });
    }

    return transactionHash as T;
  } catch (error) {
    // ... error handling ...
  }
}
```

## Benefits of the Fix

1. **Compatibility**: Now fully compatible with modern web3 stacks (wagmi, viem, Rainbow Kit)
2. **Null Safety**: Properly handles null/undefined values in transaction parameters
3. **Graceful Degradation**: Tracking failures don't break the actual transaction flow
4. **Type Safety**: Updated type definitions reflect the reality of optional fields
5. **Better Validation**: Enhanced parameter validation with clear error messages

## Testing Recommendations

To verify the fix works correctly, test with:

1. **Simple ETH transfers** (where `data` is typically null)
2. **Contract interactions** (where `data` contains contract call data)
3. **Contract deployments** (where `to` might be undefined)
4. **Zero-value transactions** (where `value` might be undefined)

## Migration Notes

This fix is **backward compatible**. Existing integrations will continue to work without any changes required. The updated SDK gracefully handles both the old format (where fields were always present) and the new format (where fields may be optional).

## Additional Considerations

- The fix ensures that null values are converted to undefined for better compatibility with validation libraries
- Default values are provided where appropriate (e.g., "0x0" for missing value)
- Enhanced logging helps with debugging transaction tracking issues
- The SDK now fails gracefully if transaction tracking encounters issues, ensuring the actual transaction still proceeds
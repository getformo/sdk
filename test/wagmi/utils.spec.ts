import { describe, it } from "mocha";
import { expect } from "chai";
import { extractFunctionArgs, AbiItem } from "../../src/wagmi/utils";

describe("wagmi/utils", () => {
  describe("extractFunctionArgs", () => {
    it("should extract function args from ABI and args array", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "transfer",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
      ];

      const result = extractFunctionArgs(abi, "transfer", [
        "0x1234567890123456789012345678901234567890",
        BigInt("1000000000000000000"),
      ]);

      expect(result).to.deep.equal({
        to: "0x1234567890123456789012345678901234567890",
        amount: "1000000000000000000",
      });
    });

    it("should convert BigInt values to strings", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "repayBorrow",
          inputs: [{ name: "repayAmount", type: "uint256" }],
        },
      ];

      const result = extractFunctionArgs(abi, "repayBorrow", [BigInt(3300000)]);

      expect(result).to.deep.equal({
        repayAmount: "3300000",
      });
    });

    it("should handle arrays containing BigInt values", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "batchTransfer",
          inputs: [
            { name: "recipients", type: "address[]" },
            { name: "amounts", type: "uint256[]" },
          ],
        },
      ];

      const result = extractFunctionArgs(abi, "batchTransfer", [
        ["0xaddr1", "0xaddr2"],
        [BigInt(100), BigInt(200)],
      ]);

      expect(result).to.deep.equal({
        recipients: ["0xaddr1", "0xaddr2"],
        amounts: ["100", "200"],
      });
    });

    it("should use indexed names for unnamed inputs", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "anonymous",
          inputs: [
            { name: "", type: "address" },
            { name: "", type: "uint256" },
          ],
        },
      ];

      const result = extractFunctionArgs(abi, "anonymous", [
        "0xaddr",
        BigInt(100),
      ]);

      expect(result).to.deep.equal({
        arg0: "0xaddr",
        arg1: "100",
      });
    });

    it("should return undefined if ABI is missing", () => {
      const result = extractFunctionArgs(
        undefined as any,
        "transfer",
        ["0xaddr"]
      );
      expect(result).to.be.undefined;
    });

    it("should return undefined if functionName is missing", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "transfer",
          inputs: [{ name: "to", type: "address" }],
        },
      ];

      const result = extractFunctionArgs(abi, "", ["0xaddr"]);
      expect(result).to.be.undefined;
    });

    it("should return undefined if args is not an array", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "transfer",
          inputs: [{ name: "to", type: "address" }],
        },
      ];

      const result = extractFunctionArgs(abi, "transfer", "0xaddr" as any);
      expect(result).to.be.undefined;
    });

    it("should return undefined if function is not found in ABI", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "transfer",
          inputs: [{ name: "to", type: "address" }],
        },
      ];

      const result = extractFunctionArgs(abi, "nonExistent", ["0xaddr"]);
      expect(result).to.be.undefined;
    });

    it("should handle functions with no inputs", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "totalSupply",
          inputs: [],
        },
      ];

      const result = extractFunctionArgs(abi, "totalSupply", []);
      expect(result).to.deep.equal({});
    });

    it("should handle functions with fewer args than inputs", () => {
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "transfer",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
      ];

      const result = extractFunctionArgs(abi, "transfer", ["0xaddr"]);
      expect(result).to.deep.equal({
        to: "0xaddr",
      });
    });

    it("should filter out non-function ABI items", () => {
      const abi: AbiItem[] = [
        {
          type: "event",
          name: "Transfer",
          inputs: [{ name: "from", type: "address", indexed: true }],
        },
        {
          type: "function",
          name: "Transfer",
          inputs: [{ name: "to", type: "address" }],
        },
      ];

      const result = extractFunctionArgs(abi, "Transfer", ["0xaddr"]);
      expect(result).to.deep.equal({
        to: "0xaddr",
      });
    });
  });
});

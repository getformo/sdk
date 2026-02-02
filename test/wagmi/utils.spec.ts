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

    it("should handle nested structs with BigInt values", () => {
      // Simulates a Solidity function like:
      // struct Order { address maker; uint256 price; uint256 amount; }
      // function submitOrder(Order calldata order) external;
      const abi: AbiItem[] = [
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
        },
      ];

      const result = extractFunctionArgs(abi, "submitOrder", [
        {
          maker: "0x1234567890123456789012345678901234567890",
          price: BigInt("1000000000000000000"),
          amount: BigInt("50000000"),
        },
      ]);

      expect(result).to.deep.equal({
        order: {
          maker: "0x1234567890123456789012345678901234567890",
          price: "1000000000000000000",
          amount: "50000000",
        },
      });
    });

    it("should handle array of structs with BigInt values", () => {
      // Simulates a Solidity function like:
      // struct Transfer { address to; uint256 amount; }
      // function batchTransfer(Transfer[] calldata transfers) external;
      const abi: AbiItem[] = [
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
        },
      ];

      const result = extractFunctionArgs(abi, "batchTransfer", [
        [
          { to: "0xaddr1", amount: BigInt(100) },
          { to: "0xaddr2", amount: BigInt(200) },
        ],
      ]);

      expect(result).to.deep.equal({
        transfers: [
          { to: "0xaddr1", amount: "100" },
          { to: "0xaddr2", amount: "200" },
        ],
      });
    });

    it("should handle deeply nested structs with BigInt values", () => {
      // Simulates a Solidity function like:
      // struct TokenAmount { address token; uint256 amount; }
      // struct SwapParams { TokenAmount input; TokenAmount output; uint256 deadline; }
      // function swap(SwapParams calldata params) external;
      const abi: AbiItem[] = [
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
                    { name: "amount", type: "uint256" },
                  ],
                },
                { name: "deadline", type: "uint256" },
              ],
            },
          ],
        },
      ];

      const result = extractFunctionArgs(abi, "swap", [
        {
          input: {
            token: "0xtoken1",
            amount: BigInt("1000000000000000000"),
          },
          output: {
            token: "0xtoken2",
            amount: BigInt("950000000000000000"),
          },
          deadline: BigInt("1700000000"),
        },
      ]);

      expect(result).to.deep.equal({
        params: {
          input: {
            token: "0xtoken1",
            amount: "1000000000000000000",
          },
          output: {
            token: "0xtoken2",
            amount: "950000000000000000",
          },
          deadline: "1700000000",
        },
      });
    });

    it("should handle multi-dimensional arrays with BigInt values", () => {
      // Simulates a Solidity function like:
      // function processMatrix(uint256[][] calldata matrix) external;
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "processMatrix",
          inputs: [{ name: "matrix", type: "uint256[][]" }],
        },
      ];

      const result = extractFunctionArgs(abi, "processMatrix", [
        [
          [BigInt(1), BigInt(2), BigInt(3)],
          [BigInt(4), BigInt(5), BigInt(6)],
        ],
      ]);

      expect(result).to.deep.equal({
        matrix: [
          ["1", "2", "3"],
          ["4", "5", "6"],
        ],
      });
    });

    it("should handle mixed nested structures with BigInt", () => {
      // Complex case: array of structs containing arrays
      const abi: AbiItem[] = [
        {
          type: "function",
          name: "complexCall",
          inputs: [
            {
              name: "data",
              type: "tuple[]",
              components: [
                { name: "amounts", type: "uint256[]" },
                { name: "flag", type: "bool" },
              ],
            },
          ],
        },
      ];

      const result = extractFunctionArgs(abi, "complexCall", [
        [
          { amounts: [BigInt(100), BigInt(200)], flag: true },
          { amounts: [BigInt(300)], flag: false },
        ],
      ]);

      expect(result).to.deep.equal({
        data: [
          { amounts: ["100", "200"], flag: true },
          { amounts: ["300"], flag: false },
        ],
      });
    });
  });
});

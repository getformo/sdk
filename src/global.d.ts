declare global {
  interface Window {
    __nightmare?: boolean;
    Cypress?: any;
    ethereum?: EIP1193Provider;
    web3?: {
      currentProvider?: EIP1193Provider;
    };
    formo?: import("./types").IFormoAnalytics;
    formofy?: (writeKey: string, options?: import("./types").Options) => void;
  }
  interface Navigator {
    brave?: {
      isBrave: () => Promise<boolean>;
    };
  }
}

export {};

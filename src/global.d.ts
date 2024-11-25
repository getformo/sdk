declare global {
  interface Window {
    __nightmare?: boolean;
    Cypress?: any; 
    ethereum?: EIP1193Provider
    web3?: {
      currentProvider?: EIP1193Provider
    }
  }
}

export {};

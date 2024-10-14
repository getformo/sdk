declare global {
  interface Window {
    __nightmare?: boolean;
    Cypress?: any; 
  }
}

export {};

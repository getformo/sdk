export const getActionDescriptor = (type: string, properties: any): string => {
  let descriptor = type;
  
  // Add status for events that have it (e.g., signature, transaction)
  if (properties?.status) {
    descriptor += ` ${properties.status}`;
  }
  
  // Add RDNS for connect/disconnect events to identify the wallet provider
  if ((type === 'connect' || type === 'disconnect') && properties?.rdns) {
    descriptor += ` (${properties.rdns})`;
  }
  
  return descriptor;
};

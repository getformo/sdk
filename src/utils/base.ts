export const getActionDescriptor = (type: string, properties: any): string => {
  return `${type}${properties?.status ? ` ${properties?.status}` : ""}`;
};

export const getActionDescriptor = (action: string, payload: any): string => {
  return `${action}${payload?.status ? ` ${payload?.status}` : ""}`;
};

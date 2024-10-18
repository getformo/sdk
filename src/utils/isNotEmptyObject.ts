export function isNotEmpty(obj: unknown): boolean {
  return obj !== null && 
         obj !== '' && 
         !(typeof obj === 'object' && Object.keys(obj).length === 0);
}
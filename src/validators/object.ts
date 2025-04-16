export const isNullish = (item: unknown): item is undefined | null =>
  // Using "null" value intentionally for validation
  // eslint-disable-next-line no-null/no-null
  item === undefined || item === null;

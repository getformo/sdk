import { ValidInputTypes } from "../types";

export const isHexStrict = (hex: ValidInputTypes) =>
  typeof hex === "string" && /^((-)?0x[0-9a-f]+|(0x))$/i.test(hex);

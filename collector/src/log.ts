const prefix = '[terminus]';
export const log = {
  info: (...a: unknown[]) => console.log(prefix, ...a),
  warn: (...a: unknown[]) => console.warn(prefix, ...a),
  error: (...a: unknown[]) => console.error(prefix, ...a),
};

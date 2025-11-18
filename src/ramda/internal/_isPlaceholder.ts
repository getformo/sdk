export default function _isPlaceholder(a: any) {
  return (
    a != null && typeof a === "object" && a["@@functional/placeholder"] === true
  );
}

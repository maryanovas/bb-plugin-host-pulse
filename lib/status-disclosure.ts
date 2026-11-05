let opener = () => {};
export function bindStatusOpener(open: () => void) {
  opener = open;
  return () => { if (opener === open) opener = () => {}; };
}
export function openServerStatus() { opener(); }

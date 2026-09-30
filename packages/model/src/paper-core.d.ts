// paper's own typings declare "paper/dist/paper-core" without the .js extension
// that NodeNext resolution needs; this maps the file we import to them.
/// <reference types="paper" />
declare module "paper/dist/paper-core.js" {
  const paperCore: paper.PaperScope;
  export default paperCore;
}

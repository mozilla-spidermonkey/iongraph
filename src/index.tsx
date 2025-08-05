import { createRoot } from 'react-dom/client';
import { GraphViewer } from './GraphViewer';
import { Func } from './iongraph';

export function render(root: HTMLElement, func: Func) {
  const reactRoot = createRoot(root);
  reactRoot.render(<GraphViewer func={func} />);
}

// Loaded only by the Playwright route; excluded from the application entry.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import FireScenePanel from '../src/components/FireScenePanel';
import type { FireScene3DProps } from '../src/components/FireScene3D';
import type { SceneActorSnapshot } from '../src/types';
import '../src/index.css';

const root = createRoot(document.getElementById('root')!);
const actors = { current: [] as readonly SceneActorSnapshot[] };

function Harness() {
  const [input, setInput] = useState<Omit<FireScene3DProps, 'actors'>>({ targetId: 'T-SW-01', status: 'burning' });
  window.onmessage = event => {
    if (event.origin !== location.origin) return;
    if (event.data.type === 'scene-input') setInput(event.data.input);
    if (event.data.type === 'scene-actors') actors.current = event.data.actors;
    if (event.data.type === 'scene-unmount') root.unmount();
  };
  return <div style={{ width: 330, margin: 20 }}><FireScenePanel {...input} actors={actors} /></div>;
}

root.render(<StrictMode><Harness /></StrictMode>);

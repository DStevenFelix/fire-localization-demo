import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

export default function LiveConfirmation({ live, onCancel, onConfirm }: { live: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [checked, setChecked] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { cancelButton.current?.focus(); }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="live-confirm-title" ref={dialog}
      onKeyDown={event => {
        if (event.key === 'Escape') onCancel();
        if (event.key === 'Tab') { const elements = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input');
          if (elements?.length) { const first = elements[0], last = elements[elements.length-1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } }
      }}>
      <button className="icon-button modal-close" aria-label="关闭确认" onClick={onCancel}><X size={18} /></button>
      <div className="warning-icon"><AlertTriangle size={25} /></div>
      <h2 id="live-confirm-title">确认启动 SocialNet 仿真</h2>
      <p>SocialNet 会调用已配置的模型持续生成帖子，直到确认已灭火或全局重置。{live ? '定位还会每 3 条调用 Chat 与 Embedding API。' : '定位使用本地规则与向量。'}</p>
      <label className="consent-checkbox"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />我确认并批准本次付费模型调用</label>
      <small>模型失败时会显示错误，不会自动切换离线模式。</small>
      <div className="modal-actions"><button className="secondary-button" onClick={onCancel} ref={cancelButton}>取消</button><button className="primary-button" disabled={!checked} onClick={onConfirm}>确认并开始仿真</button></div>
    </div>
  </div>;
}

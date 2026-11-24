import {
  cloneElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

type HintProps = {
  /** Short supplemental description; the trigger still needs an accessible name. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  content: ReactNode;
  enabled?: boolean;
};

function isFocusVisible(target?: HTMLElement) {
  try {
    return target?.matches?.(':focus-visible') ?? true;
  } catch {
    return true;
  }
}

/** A hover/focus hint rendered outside clipping ancestors. */
export function Hint({ children, content, enabled = true }: HintProps) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const pointerDown = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const visible = enabled && open;

  useEffect(() => {
    if (!enabled) {
      hovered.current = false;
      focused.current = false;
      pointerDown.current = false;
      setOpen(false);
    }
    if (!visible) return;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.min(rect.right + 8, window.innerWidth - 180),
          top: rect.top + rect.height / 2,
        });
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    update();
    window.addEventListener('keydown', dismiss);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('keydown', dismiss);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [enabled, visible]);

  const dismiss = () => {
    hovered.current = false;
    focused.current = false;
    setOpen(false);
  };
  const describedBy =
    [children.props['aria-describedby'], visible ? id : undefined].filter(Boolean).join(' ') ||
    undefined;
  return (
    // Event delegation keeps the existing focusable trigger and its semantics intact.
    // biome-ignore lint/a11y/noStaticElementInteractions: the child is the interactive element
    <span
      ref={anchor}
      className="app-hint-anchor"
      onMouseEnter={() => {
        if (!enabled || pointerDown.current) return;
        hovered.current = true;
        setOpen(true);
      }}
      onMouseLeave={() => {
        hovered.current = false;
        pointerDown.current = false;
        if (!focused.current) setOpen(false);
      }}
      onFocus={(event) => {
        if (!enabled || pointerDown.current || !isFocusVisible(event?.target)) return;
        focused.current = true;
        setOpen(true);
      }}
      onBlur={() => {
        focused.current = false;
        if (!hovered.current) setOpen(false);
      }}
      onPointerDownCapture={() => {
        pointerDown.current = true;
        dismiss();
      }}
      onPointerUpCapture={() => {
        pointerDown.current = false;
      }}
      onPointerCancelCapture={() => {
        pointerDown.current = false;
      }}
      onClickCapture={() => {
        pointerDown.current = false;
        dismiss();
      }}
    >
      {cloneElement(children, { 'aria-describedby': describedBy })}
      {visible &&
        typeof document !== 'undefined' &&
        createPortal(
          <span id={id} role="tooltip" className="app-hint" style={position}>
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

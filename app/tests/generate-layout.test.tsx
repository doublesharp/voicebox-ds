import { afterAll, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';

let profiles: { id: string }[] = [];
let opens = 0;
let fileClicks = 0;
const pass = ({ children }: { children: ReactNode }) => <>{children}</>;
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module('../src/components/Branding', () => ({ DoubleSharpMark: () => <span /> }));
mock.module('../src/components/Generation/FloatingGenerateBox', () => ({
  FloatingGenerateBox: (props: unknown) => createElement('composer', props as object),
}));
mock.module('../src/components/History/HistoryTable', () => ({
  HistoryTable: (props: unknown) => createElement('history', props as object),
}));
mock.module('../src/components/VoiceProfiles/ProfileForm', () => ({
  ProfileForm: () => <profile-form />,
}));
mock.module('../src/components/ui/button', () => ({
  Button: (props: Record<string, unknown>) => createElement('button', props),
}));
mock.module('../src/components/ui/dialog', () => ({
  Dialog: pass,
  DialogContent: pass,
  DialogDescription: pass,
  DialogFooter: pass,
  DialogHeader: pass,
  DialogTitle: pass,
}));
mock.module('../src/components/ui/use-toast', () => ({ useToast: () => ({ toast() {} }) }));
mock.module('../src/lib/hooks/useProfiles', () => ({
  useProfiles: () => ({ data: profiles, isLoading: false }),
  useImportProfile: () => ({ isPending: false, mutate() {} }),
}));
mock.module('../src/stores/uiStore', () => ({
  useUIStore: (select: (state: unknown) => unknown) =>
    select({
      setProfileDialogOpen: () => {
        opens++;
      },
    }),
}));
const { MainEditor } = await import('../src/components/MainEditor/MainEditor');
afterAll(() => mock.restore());

test('create and import remain reachable with zero and many voices', () => {
  for (profiles of [[], [{ id: 'one' }, { id: 'two' }]]) {
    opens = 0;
    fileClicks = 0;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<MainEditor />, {
        createNodeMock: (node) =>
          node.type === 'input'
            ? {
                click() {
                  fileClicks++;
                },
              }
            : null,
      });
    });
    const composers = renderer.root.findAllByType('composer' as never);
    expect(composers).toHaveLength(profiles.length ? 1 : 0);
    if (profiles.length) expect(composers[0].props.layout).toBe('docked');
    expect(renderer.root.findByType('history' as never).props.embedded).toBe(true);
    const buttons = renderer.root.findAllByType('button');
    const createVoice = buttons.find(
      (node) =>
        Array.isArray(node.props.children) && node.props.children.includes('main.createVoice'),
    );
    const importVoice = buttons.find(
      (node) =>
        Array.isArray(node.props.children) && node.props.children.includes('main.importVoice'),
    );
    expect(createVoice).toBeDefined();
    expect(importVoice).toBeDefined();
    act(() => {
      createVoice!.props.onClick();
      importVoice!.props.onClick();
    });
    expect(opens).toBe(1);
    expect(fileClicks).toBe(1);
    expect(renderer.root.findAllByType('profile-form' as never)).toHaveLength(1);
    act(() => renderer.unmount());
  }
});

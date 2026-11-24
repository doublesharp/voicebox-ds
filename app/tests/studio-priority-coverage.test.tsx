import { afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

let endpoint = 'http://one',
  destination: any;
let list: (server: string) => Promise<any> = async () => ({ items: [] });
let createProject: (body: any) => Promise<any> = async () => ({ id: 'new' });
let stories: () => Promise<any[]> = async () => [];
let importStory: (id: string) => Promise<any> = async () => ({ id: 'copy' });
let importArchive: (file: File) => Promise<any> = async () => ({ id: 'archive' });
let renderer: ReactTestRenderer;
const pass = ({ children }: any) => <>{children}</>;
mock.module('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }));
mock.module('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: () => async (value: unknown) => {
    destination = value;
  },
}));
mock.module('../src/stores/serverStore', () => ({
  useServerStore: (select: any) => select({ serverUrl: endpoint }),
}));
mock.module('../src/features/studio/client', () => ({
  StudioClient: class {
    baseUrl: string;
    constructor(server: string) {
      this.baseUrl = server;
    }
    projects() {
      return list(this.baseUrl);
    }
    createProject(body: any) {
      return createProject(body);
    }
    stories() {
      return stories();
    }
    importStory(id: string) {
      return importStory(id);
    }
    importArchive(file: File) {
      return importArchive(file);
    }
  },
}));
mock.module('../src/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => <div data-project-dialog-open={open}>{children}</div>,
  DialogContent: ({ children, onCloseAutoFocus }: any) => (
    <div data-dialog-content onCloseAutoFocus={onCloseAutoFocus}>
      {children}
    </div>
  ),
  DialogDescription: pass,
  DialogHeader: pass,
  DialogTitle: pass,
  DialogTrigger: pass,
}));
mock.module('../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: pass,
  DropdownMenuTrigger: pass,
  DropdownMenuContent: pass,
  DropdownMenuItem: ({ children, onSelect }: any) => (
    <button type="button" role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
}));
mock.module('../src/features/studio/StorageCleanupDialog', () => ({
  StorageCleanupDialog: () => null,
}));
const { ProjectsPage } = await import('../src/features/studio/ProjectsPage');
function text(value: any): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  return value?.props ? text(value.props.children) : '';
}
const button = (label: string) =>
  renderer.root.findAllByType('button').find((n) => text(n.props.children).includes(label))!;
const input = (placeholder: string) => renderer.root.findByProps({ placeholder });
function field(label: string) {
  const id = renderer.root
    .findAllByType('label')
    .find((node) => text(node.props.children) === label)!.props.htmlFor;
  return [...renderer.root.findAllByType('input'), ...renderer.root.findAllByType('textarea')].find(
    (node) => node.props.id === id,
  )!;
}
async function mount() {
  await act(async () => {
    renderer = create(<ProjectsPage />);
  });
}
async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
  });
}
afterEach(() => {
  act(() => renderer?.unmount());
  endpoint = 'http://one';
  destination = undefined;
  list = async () => ({ items: [] });
  createProject = async () => ({ id: 'new' });
  stories = async () => [];
  importStory = async () => ({ id: 'copy' });
  importArchive = async () => ({ id: 'archive' });
});
test('lists, filters, and links projects', async () => {
  list = async () => ({
    items: [
      { id: 'a', name: 'First', client_label: 'Acme', revision: 2, updated_at: '2026-01-01' },
      { id: 'b', name: 'Second', client_label: null, revision: 1, updated_at: '2026-01-01' },
    ],
  });
  await mount();
  act(() => input('Search projects or clients').props.onChange({ target: { value: 'ACME' } }));
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Second');
  expect(
    renderer.root.findAllByType('a').find((n) => text(n.props.children).includes('First'))!.props
      .params,
  ).toEqual({ projectId: 'a', workspace: 'edit' });
  act(() => input('Search projects or clients').props.onChange({ target: { value: 'missing' } }));
  expect(JSON.stringify(renderer.toJSON())).toContain('No matching projects');
});
test('creation submits trimmed metadata once while pending and navigates', async () => {
  let resolve!: (value: any) => void;
  const calls: any[] = [];
  createProject = (body) => {
    calls.push(body);
    return new Promise((r) => {
      resolve = r;
    });
  };
  await mount();
  act(() => field('Project name').props.onChange({ target: { value: '  Title  ' } }));
  act(() => field('Client / collection').props.onChange({ target: { value: ' Client ' } }));
  act(() => field('Script').props.onChange({ target: { value: 'One\n\nTwo' } }));
  expect(
    text(
      renderer.root
        .findAllByType('summary')
        .find((n) => text(n.props.children).includes('passages'))!.props.children,
    ),
  ).toContain('2 passages');
  const submit = renderer.root.findByType('form').props.onSubmit;
  await act(async () => {
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
  });
  expect(calls).toEqual([
    { name: 'Title', client_label: 'Client', script: 'One\n\nTwo', language: 'en' },
  ]);
  await act(async () => {
    resolve({ id: 'created' });
  });
  expect(destination.params.projectId).toBe('created');
});
test('load failure is visible and retry restores the list', async () => {
  let count = 0;
  list = async () => {
    if (++count === 1) throw new Error('offline');
    return { items: [{ id: 'a', name: 'Recovered', revision: 0, updated_at: '2026-01-01' }] };
  };
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain('offline');
  await click('Retry loading');
  expect(JSON.stringify(renderer.toJSON())).toContain('Recovered');
});
test('copies the selected Story', async () => {
  const calls: string[] = [];
  stories = async () => [{ id: 's', name: 'Original' }];
  importStory = async (id) => {
    calls.push(id);
    return { id: 'copied' };
  };
  await mount();
  await click('Copy from Story…');
  act(() => renderer.root.findByType('select').props.onChange({ target: { value: 's' } }));
  await click('Create studio copy');
  expect(calls).toEqual(['s']);
  expect(destination.params.projectId).toBe('copied');
});
test('late creation and list results from the old server are ignored', async () => {
  let resolveCreate!: (value: any) => void, resolveList!: (value: any) => void;
  list = (server) =>
    server === 'http://one'
      ? new Promise((r) => {
          resolveList = r;
        })
      : Promise.resolve({
          items: [{ id: 'b', name: 'New server', revision: 0, updated_at: '2026-01-01' }],
        });
  createProject = () =>
    new Promise((r) => {
      resolveCreate = r;
    });
  await mount();
  act(() => field('Project name').props.onChange({ target: { value: 'Title' } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  endpoint = 'http://two';
  await act(async () => renderer.update(<ProjectsPage />));
  await act(async () => {
    resolveCreate({ id: 'old' });
    resolveList({ items: [{ id: 'old', name: 'Old server' }] });
  });
  expect(destination).toBeUndefined();
  expect(JSON.stringify(renderer.toJSON())).toContain('New server');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Old server');
});

test('creation failure is shown and a later attempt can succeed', async () => {
  let calls = 0;
  createProject = async () => {
    if (++calls === 1) throw new Error('creation failed');
    return { id: 'success' };
  };
  await mount();
  act(() => field('Project name').props.onChange({ target: { value: 'Title' } }));
  const submit = () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  await act(async () => submit());
  expect(JSON.stringify(renderer.toJSON())).toContain('creation failed');
  expect(destination).toBeUndefined();
  await act(async () => submit());
  expect(destination.params.projectId).toBe('success');
});
test('archive import passes the chosen file and resets the input', async () => {
  let received: File | undefined;
  importArchive = async (file) => {
    received = file;
    return { id: 'imported' };
  };
  await mount();
  const file = new File(['zip'], 'project.zip');
  const target = { files: [file], value: 'chosen' };
  await act(async () =>
    renderer.root.findByProps({ 'aria-label': 'Import studio archive' }).props.onChange({ target }),
  );
  expect(received).toBe(file);
  expect(target.value).toBe('');
  expect(destination.params.projectId).toBe('imported');
});

test('desktop project toolbar opens the existing dialog and focuses project search', async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const portalTarget = {};
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: (id: string) =>
        id === 'desktop-toolbar-context-actions' ? portalTarget : null,
    },
  });
  let focused = 0;
  let createButtonFocused = 0;
  try {
    await act(async () => {
      renderer = create(<ProjectsPage />, {
        createNodeMock: (element) =>
          element.type === 'input' && element.props['aria-label'] === 'Search projects'
            ? { focus: () => focused++ }
            : element.type === 'button' && element.props['aria-haspopup'] === 'dialog'
              ? { focus: () => createButtonFocused++ }
              : null,
      });
    });
    const toolbarNew = renderer.root.findByProps({ 'aria-haspopup': 'dialog' });
    await act(async () => toolbarNew.props.onClick());
    expect(renderer.root.findAllByProps({ 'data-project-dialog-open': true })).toHaveLength(1);
    act(() => renderer.root.findByProps({ 'aria-label': 'Focus project search' }).props.onClick());
    expect(focused).toBe(1);
    let defaultPrevented = false;
    act(() =>
      renderer.root.findAllByProps({ 'data-dialog-content': true })[0].props.onCloseAutoFocus({
        preventDefault: () => {
          defaultPrevented = true;
        },
      }),
    );
    expect(defaultPrevented).toBe(true);
    expect(createButtonFocused).toBe(1);
    expect(
      renderer.root.findAllByType('button').find((node) => node.props.hidden)?.props.hidden,
    ).toBe(true);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

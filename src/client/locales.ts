/**
 * Copy for the editor: the view name in the preview's view menu, the status
 * strip, and every failure the edit path can return. Keys are typed from the
 * `zh` dictionary, so a language that misses one fails typecheck.
 *
 * @module dsh-explorer-editor/client/locales
 */

/** Locale namespace this plugin owns. */
export const NS = 'explorerEditor'

/** Simplified Chinese copy. */
export const zh = {
  'viewer.editor': '编辑器',
  'editor.loading': '正在加载编辑器…',
  'editor.save': '保存',
  'editor.saving': '正在保存…',
  'editor.unsaved': '未保存',
  'editor.reloadFromDisk': '从磁盘重新载入',
  'editor.overwrite': '覆盖保存',
  'editor.conflict': '文件在编辑期间被改动过，保存会覆盖对方的修改。',
  'editor.limitedTypes': '类型补全不完整',
  'error.not-found': '文件已不存在，可能被删除或重命名。',
  'error.outside-workspace': '该路径不在当前会话的工作区内，无法保存。',
  'error.stale-version': '文件在编辑期间被改动过。',
  'error.too-large': '文件超过可编辑的大小上限（{limit}）。',
  'error.denied': '当前会话是只读模式，切换到可写权限后才能保存。',
  'error.not-regular-file': '目标不是普通文件，无法保存。',
  'error.bad-request': '请求被拒绝。',
  'error.io-error': '写入失败，请稍后重试。',
  'error.not-text': '这个文件不是 UTF-8 文本，无法编辑。',
  'error.binary': '这个文件看起来是二进制内容，无法编辑。',
  'error.read-failed': '读取文件失败，请重试。',
  'error.offline': '连不上本地服务，编辑功能不可用。',
  'error.http': '请求失败（HTTP {status}）。',
  'error.editor-load': '编辑器加载失败，无法打开这个文件。',
} satisfies Record<string, string>

/** Dictionary keys every language must provide. */
export type ExplorerEditorKey = keyof typeof zh

/** English copy. */
export const en = {
  'viewer.editor': 'Editor',
  'editor.loading': 'Loading the editor…',
  'editor.save': 'Save',
  'editor.saving': 'Saving…',
  'editor.unsaved': 'Unsaved',
  'editor.reloadFromDisk': 'Reload from disk',
  'editor.overwrite': 'Overwrite',
  'editor.conflict': 'This file changed while you were editing it; saving overwrites the other change.',
  'editor.limitedTypes': 'Completion is partial',
  'error.not-found': 'The file no longer exists; it may have been deleted or renamed.',
  'error.outside-workspace': 'That path is outside this session\'s workspace, so it cannot be saved.',
  'error.stale-version': 'The file changed while you were editing it.',
  'error.too-large': 'The file exceeds the editable size limit ({limit}).',
  'error.denied': 'This session is read-only. Switch to a writable mode to save.',
  'error.not-regular-file': 'The target is not a regular file, so it cannot be saved.',
  'error.bad-request': 'The request was rejected.',
  'error.io-error': 'The write failed. Try again.',
  'error.not-text': 'This file is not UTF-8 text, so it cannot be edited.',
  'error.binary': 'This file looks like binary content, so it cannot be edited.',
  'error.read-failed': 'Could not read the file. Try again.',
  'error.offline': 'The local service is unreachable, so editing is unavailable.',
  'error.http': 'The request failed (HTTP {status}).',
  'error.editor-load': 'The editor failed to load, so this file cannot be opened.',
} satisfies Record<ExplorerEditorKey, string>

/** Japanese copy. */
export const ja = {
  'viewer.editor': 'エディター',
  'editor.loading': 'エディターを読み込み中…',
  'editor.save': '保存',
  'editor.saving': '保存中…',
  'editor.unsaved': '未保存',
  'editor.reloadFromDisk': 'ディスクから再読み込み',
  'editor.overwrite': '上書き保存',
  'editor.conflict': '編集中にファイルが変更されました。保存すると相手の変更を上書きします。',
  'editor.limitedTypes': '補完は一部のみ',
  'error.not-found': 'ファイルは既に存在しません。削除または名前変更された可能性があります。',
  'error.outside-workspace': 'そのパスはこのセッションのワークスペース外のため保存できません。',
  'error.stale-version': '編集中にファイルが変更されました。',
  'error.too-large': 'ファイルが編集可能なサイズ上限（{limit}）を超えています。',
  'error.denied': 'このセッションは読み取り専用です。書き込み可能なモードに切り替えてください。',
  'error.not-regular-file': '対象は通常のファイルではないため保存できません。',
  'error.bad-request': 'リクエストが拒否されました。',
  'error.io-error': '書き込みに失敗しました。もう一度お試しください。',
  'error.not-text': 'このファイルは UTF-8 テキストではないため編集できません。',
  'error.binary': 'このファイルはバイナリのようです。編集できません。',
  'error.read-failed': 'ファイルを読み込めませんでした。もう一度お試しください。',
  'error.offline': 'ローカルサービスに接続できないため、編集は利用できません。',
  'error.http': 'リクエストが失敗しました（HTTP {status}）。',
  'error.editor-load': 'エディターの読み込みに失敗したため、このファイルを開けません。',
} satisfies Record<ExplorerEditorKey, string>

/** Every dictionary this plugin registers. */
export const dictionaries = { zh, en, ja }

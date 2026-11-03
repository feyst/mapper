import $ from 'jquery'
import {loadJq} from 'jq-wasm'
import xmlFormat from 'xml-formatter'
import {format} from 'jsonc-parser'

import {EditorView, basicSetup} from 'codemirror'
import {keymap, showPanel} from '@codemirror/view'
import {insertTab, indentSelection} from '@codemirror/commands'
import {EditorState, Compartment, StateEffect, StateField} from '@codemirror/state'
import {StreamLanguage, indentUnit} from '@codemirror/language'
import {simpleMode} from '@codemirror/legacy-modes/mode/simple-mode'
import {xml} from '@codemirror/lang-xml'
import {json, jsonParseLinter} from '@codemirror/lang-json'
import {linter, lintGutter, setDiagnostics, forceLinting} from '@codemirror/lint'
import {oneDark} from '@codemirror/theme-one-dark'

import jsonToXmlStylesheet from './json-to-xml.xsl'
import './style.css'

const debounce = 600;

// Rough cost of a run per kilobyte or megabyte of text, measured in Chromium. SaxonJS compiles the template from its
// text on every run, and a JSON source is converted to XML first. jq runs are fast enough to leave out.
const secondsPerTemplateKb = 0.05
const secondsPerXmlSourceMb = 0.25
const secondsPerJsonSourceMb = 1.25
// A load that makes a run take longer than this switches Auto run off, so a slow run does not follow every pause in
// typing.
const autoRunLimitSeconds = 5
// formatXml() takes time that grows with the square of the text's length: about 3 s for 1 MB, minutes for 10 MB.
const prettifyXmlLimit = 1000 * 1000

const jqMode = {
    start: [
        {regex: / ?/, next: 'expression'}
    ],
    object: [
        {regex: / ?/, token: 'bracket', push: 'key'},
        {regex: ',', token: 'bracket', push: 'key'},
        {regex: '}', token: 'bracket', pop: true}
    ],
    array: [
        {regex: ',', token: 'bracket'},
        {regex: / ?/, push: 'value'},
        {regex: ']', token: 'bracket', pop: true}
    ],
    key: [
        {regex: /[a-z]\w*/i, token: 'keyword'},
        {regex: '"', token: 'string', push: 'string'},
        {regex: /\(/, token: 'variable-2', push: 'expression'},
        {regex: ':', token: 'bracket', push: 'value'}
    ],
    value: [
        {regex: /null|true|false/, token: 'atom'},
        {regex: /\d+/, token: 'number'},
        {regex: /\.\w+/, token: 'tag'},
        {regex: /\(/, token: 'variable-2', push: 'expression'},
        {regex: '"', token: 'string', push: 'string'},
        {regex: '{', token: 'bracket', push: 'object'},
        {regex: /\[/, token: 'bracket', push: 'array'},
        {regex: /[,}\]]/, token: 'bracket', pop: true}
    ],
    string: [
        {regex: /[^"\\]+/, token: 'string'},
        {regex: /\\\(/, token: 'variable-2', push: 'expression'},
        {regex: '"', token: 'string', pop: true}
    ],
    expression: [
        {regex: /\.\w+/, token: 'tag'},
        {regex: /\w+|==|!=|\|/, token: 'builtin'},
        {regex: /\(/, token: 'variable-2', push: 'expression'},
        {regex: /\)/, token: 'variable-2', pop: true},
        {regex: '{', token: 'bracket', push: 'object'},
        {regex: /\[/, token: 'bracket', push: 'array'}
    ]
};

const jqLanguage = StreamLanguage.define({...simpleMode(jqMode), name: 'jq'});

// Starts fetching the jq WebAssembly module at page load; every jq call awaits it.
const jqReady = loadJq();

let sourceEditor, mappingEditor, resultEditor;

// The texts of processFields()'s last XSLT run and the error it threw, or null. The mapping editor's linter reuses that
// outcome when the texts are the same, instead of running the template again. Run and Auto run always run the
// template, so output that differs between runs, such as current-dateTime(), is new on every Run.
let lastRun = {source: null, mapping: null, error: null}

// Makes the mapping editor's linter check the template again although the template did not change.
const refreshMarks = StateEffect.define()

const languages = {
    xml: () => xml(),
    xsl: () => [xml(), linter(xslValidator, {
        needsRefresh: update => update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshMarks))),
    })],
    json: () => [json(), linter(jsonParseLinter())],
    jq: () => [jqLanguage, linter(jqValidator)],
}

const setMessage = StateEffect.define()

// A message shown above the editor's content, such as why a file was not loaded; null removes it.
const messagePanel = StateField.define({
    create: () => null,
    update: (message, transaction) => transaction.effects.reduce((value, effect) => effect.is(setMessage) ? effect.value : value, message),
    provide: field => showPanel.from(field, message => message ? () => {
        const dom = document.createElement('div')
        dom.className = 'cm-message'
        dom.setAttribute('role', 'alert')
        dom.textContent = message
        return {dom, top: true}
    } : null),
})

class Editor {
    constructor(parent, {readOnly = false, onChange = null, onDropFile = null} = {}) {
        this.mode = null
        this.language = new Compartment()
        this.readOnly = readOnly
        this.view = new EditorView({
            parent,
            extensions: [
                basicSetup,
                indentUnit.of('    '),
                lintGutter(),
                window.matchMedia('(prefers-color-scheme: dark)').matches ? oneDark : EditorView.theme({'&': {backgroundColor: 'white'}}),
                EditorState.readOnly.of(readOnly),
                // CodeMirror 6 leaves Tab to the browser; bind it the way CodeMirror 5 did.
                readOnly ? [] : keymap.of([{key: 'Tab', run: insertTab, shift: indentSelection}]),
                this.language.of([]),
                messagePanel,
                onChange ? EditorView.updateListener.of(update => update.docChanged && onChange()) : [],
                // A file dropped on the editor is loaded like a chosen one. CodeMirror would otherwise insert its text
                // at the drop position, without the checks of readSourceFile().
                onDropFile ? EditorView.domEventHandlers({
                    drop: event => {
                        const file = event.dataTransfer?.files[0]
                        if (!file) {
                            return false
                        }
                        onDropFile(file)
                        return true
                    },
                }) : [],
            ],
        })
    }

    // Shows a message above the editor's content; null removes it.
    setMessage(message) {
        this.view.dispatch({effects: setMessage.of(message)})
    }

    getValue() {
        return this.view.state.doc.toString()
    }

    // Replaces only the part that differs, so the scroll position, folds and selection survive a re-run that changes
    // little or nothing.
    setValue(value, {scrollToEnd = false} = {}) {
        // The document only holds \n line breaks, so other line endings would never match in the comparison below.
        value = value.replace(/\r\n?/g, '\n')
        const current = this.getValue()
        const maxLength = Math.min(current.length, value.length)
        let start = 0
        while (start < maxLength && current[start] === value[start]) {
            start++
        }
        let end = 0
        while (end < maxLength - start && current[current.length - 1 - end] === value[value.length - 1 - end]) {
            end++
        }
        this.view.dispatch({
            changes: {from: start, to: current.length - end, insert: value.slice(start, value.length - end)},
            effects: scrollToEnd ? EditorView.scrollIntoView(value.length) : [],
        })
    }

    append(value) {
        const end = this.view.state.doc.length
        this.view.dispatch({
            changes: {from: end, insert: value},
            effects: EditorView.scrollIntoView(end + value.length),
        })
    }

    // Read-only editors skip the JSON linter: they show generated output, and raw jq output is not JSON.
    setMode(mode) {
        if (this.mode === mode) {
            return
        }
        this.mode = mode
        const language = this.readOnly && 'json' === mode ? json() : languages[mode]()
        // Diagnostics outlive the linter that produced them, so clear them along with the old language.
        this.view.dispatch(setDiagnostics(this.view.state, []), {effects: this.language.reconfigure(language)})
    }
}

// Diagnostic spanning a whole line, clamped to the document because error messages can point past its end.
function lineDiagnostic(doc, lineIndex, message) {
    const line = doc.line(Math.min(Math.max(lineIndex + 1, 1), doc.lines))
    return {from: line.from, to: line.to, message, severity: 'error'}
}

// Only compile errors (jq exit code 3) are reported: the filter runs against an empty object here, so runtime errors
// say nothing about the actual source.
async function jqValidator(view) {
    const doc = view.state.doc
    const {stderr, exitCode} = (await jqReady).raw({}, doc.toString())
    if (3 !== exitCode) {
        return []
    }
    return stderr.split('jq: ')
        .filter(error => error !== '' && !error.match(/\d+ compile errors?/g))
        .map(error => {
            const lineNumber = error.match(/, line (\d+)(?:, column \d+)?:/)
            return lineDiagnostic(doc, (lineNumber ? parseInt(lineNumber[1]) : 2) - 1, error)
        })
}

function xslValidator(view) {
    const doc = view.state.doc
    const text = doc.toString()
    const source = sourceEditor.getValue()
    let exception = null
    if (source === lastRun.source && text === lastRun.mapping) {
        exception = lastRun.error
    } else if (!$('#autoRun')[0].checked) {
        // With Auto run off nothing runs until Run is clicked, so a slow template does not freeze the page after every
        // pause in typing. The run brings the marks.
        return []
    } else {
        try {
            runXsl3(source, text)
        } catch (e) {
            exception = e
        }
    }
    if (null === exception) {
        return []
    }
    let lineNumber = 0
    let searchLineNumber = exception.message.match(/(?<=on line )\d+(?= )/m)
    if (searchLineNumber && !exception.xsltModule) {
        lineNumber = parseInt(searchLineNumber[0]) - 1
    }
    // SaxonJS gives the position of the element that holds the failing code (the n-th element), not its line.
    let elementNumber = exception.message.match(/(?<= on line )\d+(?= in \S* {)/) ?? String(exception.errorObject).match(/(?<=^ on line )\d+(?= in \S*$)/)
    if (elementNumber) {
        lineNumber = lineNumberOfIndex(text, indexOfElement(text, parseInt(elementNumber[0]))) - 1
    }
    return [lineDiagnostic(doc, lineNumber, exception.message)]
}

// Index of the n-th start tag, skipping comments, CDATA sections, processing instructions and the doctype.
function indexOfElement(text, n) {
    const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?]]>|<[?!][^>]*>|<(?!\/)/g
    let match
    while ((match = markup.exec(text))) {
        if ('<' === match[0] && 0 === --n) {
            return match.index
        }
    }
    return 0
}

// XML that does not parse is returned unchanged: without strictMode the parser would add the closing tags missing from
// truncated or malformed input. The line separator is set because it defaults to \r\n.
function formatXml(text) {
    return xmlFormat(text, {indentation: '    ', collapseContent: true, lineSeparator: '\n', strictMode: true, throwOnFailure: false})
}

// XML longer than prettifyXmlLimit is shown as it is.
function canPrettify(text) {
    return !isXml(text) || text.length <= prettifyXmlLimit
}

// Runs fn once calls have stopped for `wait` milliseconds.
function debounced(fn, wait) {
    let timer
    return (...args) => {
        clearTimeout(timer)
        timer = setTimeout(() => fn(...args), wait)
    }
}

function formatJson(text) {
    return JSON.stringify(JSON.parse(text), null, 4)
}

// Adds line breaks and indentation to JSON without touching its tokens, so numbers, key order and duplicate keys stay
// as written and the template sees the file's data. jsonc-parser's applyEdits() is quadratic in the number of edits,
// so they are applied in one pass. Where the indent would be exactly 200 characters (50 levels deep), format() returns
// an edit without content; treating it as empty only loses a line break.
function reindentJson(text) {
    JSON.parse(text) // throws for text that is not JSON, which then loads unchanged
    const edits = format(text, undefined, {tabSize: 4, insertSpaces: true, eol: '\n'})
        .sort((a, b) => a.offset - b.offset)
    const parts = []
    let position = 0
    for (const edit of edits) {
        parts.push(text.slice(position, edit.offset), edit.content ?? '')
        position = edit.offset + edit.length
    }
    parts.push(text.slice(position))
    return parts.join('')
}

function lineNumberOfIndex(text, index) {
    let beforeText = text.substr(0, index)

    return beforeText.split('\n').length
}

function isXml(string) {
    return null != string && string.trim().match(/^</)
}

function setEditorModes(source, mapping, result) {
    sourceEditor.setMode(isXml(source) ? 'xml' : 'json')
    if (isXml(mapping)) {
        mappingEditor.setMode('xsl')
        $('#jqRawOption')[0].style.display = 'none'
    } else if (mapping !== '') {
        mappingEditor.setMode('jq')
        $('#jqRawOption')[0].style.display = 'inline'
    }
    resultEditor.setMode(isXml(result) ? 'xml' : 'json')
}

async function autoProcess() {
    const mapping = mappingEditor.getValue()

    if (sourceEditor.getValue().length > 5 && mapping.length > 5 && ((isXml(mapping) && !mapping.includes('<xsl:stylesheet')) || !isXml(mapping))) {
        $('#autoMapButton').show()
    } else {
        $('#autoMapButton').hide()
    }

    if ($('#autoRun').get(0).checked) {
        return await processFields();
    }
}

async function autoMap() {
    try {
        $('#mappingLoading').show()
        $('#mappingUpload').hide()

        const response = await fetch('https://52lf3ti6pjqfvxqabng6egeyf40nhjkw.lambda-url.eu-west-1.on.aws/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                source: sourceEditor.getValue(),
                template: mappingEditor.getValue(),
            })
        })

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

        mappingEditor.setValue('')

        while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            mappingEditor.append(value)
        }

        mappingEditor.setValue(formatXml(mappingEditor.getValue()), {scrollToEnd: true})

    } catch (e) {
        console.log(e)
    }
    $('#mappingLoading').hide()
    $('#mappingUpload').show()

}

async function processFields() {
    try {
        $('#result .inProgress').show();
        let result = '';
        let source = sourceEditor.getValue()
        let mapping = mappingEditor.getValue()

        if (!isXml(source) && !isXml(mapping)) {
            source = jqAutoSlurp(source);
            result = await runJq(source, mapping) ?? ''
        }

        if (isXml(mapping)) {
            lastRun = {source, mapping, error: null}
            try {
                result = await runXsl3(source, mapping) ?? ''
            } catch (e) {
                lastRun.error = e
            }
        }

        setEditorModes(source, mapping, result)
        if (isXml(mapping)) {
            // The marks follow every run, also when only the source changed or Run was clicked. The check reads this
            // run's outcome from lastRun, so it does not run the template again.
            mappingEditor.view.dispatch({effects: refreshMarks.of(null)})
            forceLinting(mappingEditor.view)
        }

        resultEditor.setValue(result)
    } catch (e) {
    }
    $('#result .inProgress').hide();
}

function jqAutoSlurp(source) {
    try {
        JSON.parse(source);

        return source;
    } catch (syntaxError) {
        const starts = ['{', '[', '"'];
        const ends = ['}', ']', '"'];
        const lines = source.split(/\r?\n/).filter(v => 0 !== v.length);
        const start = lines[0].substr(0, 1);
        if (lines.length > 1 && starts.includes(start)) {
            const end = ends[starts.findIndex(v => v === start)];
            for (let x in lines) {
                if (!lines[x].startsWith(start) || !lines[x].trim().endsWith(end)) {
                    return source;
                }
            }

            source = '[' + lines.join(',') + ']';
        }
    }

    return source;
}

async function runJq(source, mapping) {
    try {
        const jq = await jqReady
        // jq-wasm passes string input through as JSON text, so the parsed source goes back in serialized.
        const input = JSON.stringify(JSON.parse(source))
        let result;
        if ($('#jqRaw')[0].checked) {
            // Raw output keeps whatever jq printed before a runtime error.
            result = jq.raw(input, mapping, ['-r']).stdout
        } else {
            // Throws on any jq error, so JSON output is shown only when the whole filter succeeded.
            const outputs = jq.json(input, mapping)
            if (0 === outputs.length) {
                return ''
            }
            // Several outputs are combined into one array so the result stays a single JSON document.
            result = JSON.stringify(1 === outputs.length ? outputs[0] : outputs)
        }
        try {
            result = formatJson(result)
        } catch (e) {
        }
        return result
    } catch (e) {
        return '';
    }
}

// The JSON source as the document a template is applied to. A new document for every run: SaxonJS does not document
// that fn:transform() leaves its source node unchanged, so a document passed to one run is not passed to the next.
function jsonToXml(json) {
    return SaxonJS.XPath.evaluate(
        "transform(map{'stylesheet-text': $stylesheet, 'stylesheet-params': map{QName('', 'json'): $json}," +
        " 'initial-template': QName('http://www.w3.org/1999/XSL/Transform', 'initial-template')})?output",
        null, {params: {stylesheet: jsonToXmlStylesheet, json}})
}

// fn:transform() compiles the template from its text, the only documented way to compile in the browser build.
function runXsl3(source, mapping) {
    let result = SaxonJS.XPath.evaluate(
        "transform(map{'stylesheet-text': $mapping, 'delivery-format': 'serialized'," +
        " 'source-node': if (exists($json)) then $json else parse-xml($source)})?output",
        null, {params: {mapping, source, json: isJson(source) ? jsonToXml(source) : null}})

    if (isJson(result.trim())) {
        return JSON.stringify(JSON.parse(result), null, 4)
    }

    if (isXml(result) && canPrettify(result)) {
        return formatXml(result)
    }

    return result
}

// JSON must be UTF-8 without a byte order mark (RFC 8259, section 8.1), so any other JSON file is refused. The check
// reads the bytes, because File.text() hides both: it drops a byte order mark, decodes UTF-16 by its byte order mark
// and turns bytes that are not UTF-8 into U+FFFD. XML may use any encoding File.text() reads.
async function readSourceFile(file) {
    const text = await file.text()
    if (isXml(text)) {
        return text
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (0xEF === bytes[0] && 0xBB === bytes[1] && 0xBF === bytes[2]) {
        throw new Error('File not loaded: it starts with a byte order mark (BOM), which JSON must not have (RFC 8259, section 8.1).')
    }
    try {
        // fatal makes decode() throw on bytes that are not UTF-8, UTF-16 included. It drops a leading byte order mark
        // without complaint, hence the check above.
        new TextDecoder('utf-8', {fatal: true}).decode(bytes)
    } catch (e) {
        throw new Error('File not loaded: it is not valid UTF-8, the encoding JSON must have (RFC 8259, section 8.1).')
    }
    return text
}

// File.text() reads an XML file as UTF-8, whatever encoding its declaration names. Returns a warning for an XML file
// that is not UTF-8, or null. The declaration comes first in a file, so it is looked for in the first 100 bytes,
// written as encoding="…" or encoding='…'.
function xmlEncodingWarning(bytes) {
    const declared = String.fromCharCode(...bytes.subarray(0, 100)).match(/<\?xml\s+[^>]*encoding=["']([^"']+)["']/i)?.[1]
    let reason = null
    if ((0xFF === bytes[0] && 0xFE === bytes[1]) || (0xFE === bytes[0] && 0xFF === bytes[1])) {
        reason = 'it is in UTF-16 or UTF-32'
    } else if (declared && !/^utf-?8$/i.test(declared)) {
        reason = `its XML declaration names encoding ${declared}`
    } else {
        try {
            new TextDecoder('utf-8', {fatal: true}).decode(bytes)
        } catch (e) {
            reason = 'it contains bytes that are not UTF-8'
        }
    }
    return reason && `File loaded, but it is not UTF-8: ${reason}.`
}

// Loads a chosen or dropped file into an editor. load holds the editor, its file input, the element that shows the
// loaded file's name, its Prettify box, read(), which returns the file's text or throws with the message to show, and
// mode(), which returns the editor's language for a text.
async function loadFile(file, load) {
    let content
    try {
        content = await load.read(file)
    } catch (e) {
        // The editor keeps its content, so the name of the file loaded before stays too.
        load.editor.setMessage(e.message)
        return
    } finally {
        // Otherwise choosing the same file again fires cancel instead of change, and nothing loads.
        load.input.value = ''
    }
    // A long name is cut off; the tooltip shows all of it.
    load.name.textContent = file.name
    load.name.title = file.name
    // Checked on the file's bytes, before any prettifying.
    load.editor.setMessage(isXml(content) ? xmlEncodingWarning(new Uint8Array(await file.arrayBuffer())) : null)
    // Set before the content, so the file is highlighted also when nothing runs, and no check is scheduled in the
    // editor's previous language.
    load.editor.setMode(load.mode(content))

    // A file on at most two lines, such as a minified one, is prettified so it can be read; any other file is shown as
    // it is. The box shows which, and switches between the two until the content is edited.
    load.loaded = content
    load.prettify.checked = canPrettify(content) && (content.match(/\n/g) ?? []).length <= 2
    showLoaded(load)
    checkRunCost()
}

// Switches Auto run off when a run with the texts shown would be slow, and says so above the result. Only a load does
// this, so once the user has switched Auto run back on, it stays on until the next load.
function checkRunCost() {
    const seconds = estimatedRunSeconds(sourceEditor.getValue(), mappingEditor.getValue())
    if (seconds <= autoRunLimitSeconds) {
        resultEditor.setMessage(null)
        return
    }
    $('#autoRun').prop('checked', false).trigger('change')
    resultEditor.setMessage(`Auto run is switched off: with these files a run takes about ${Math.round(seconds)} s. Click Run to see the result.`)
}

// Rough seconds a run takes. Prettifying the result is left out: prettifyXmlLimit keeps it short.
function estimatedRunSeconds(source, mapping) {
    if (!isXml(mapping)) {
        return 0
    }
    const secondsPerSourceMb = isXml(source) ? secondsPerXmlSourceMb : secondsPerJsonSourceMb
    return mapping.length / 1000 * secondsPerTemplateKb + source.length / 1000000 * secondsPerSourceMb
}

// Shows the last file loaded into an editor, prettified when its Prettify box is ticked.
function showLoaded({editor, loaded, prettify}) {
    let content = loaded
    if (prettify.checked) {
        if (isXml(content)) {
            content = formatXml(content)
        } else {
            try {
                content = reindentJson(content)
            } catch (e) {
            }
        }
    }

    editor.setValue(content)
    // The editor's onChange disabled the box during setValue(); only other changes, and XML too long to prettify, keep
    // it disabled.
    prettify.disabled = !canPrettify(loaded)
    if (prettify.disabled) {
        prettify.labels[0].title = 'Disabled because XML larger than 1 MB takes too long to prettify.'
    } else {
        prettify.labels[0].removeAttribute('title')
    }
}

// Once an editor's content changed, its Prettify box would replace the edits, so it stays disabled until the next load.
// A tooltip says why; it is on the box's label, so it also shows over the word Prettify. Before the first load the box is
// disabled because there is nothing to prettify, and it has no tooltip.
function disablePrettify({loaded, prettify}) {
    prettify.disabled = true
    if (undefined !== loaded) {
        prettify.labels[0].title = 'Disabled because the content was changed after the file was loaded. Load the file again to toggle Prettify.'
    }
}

function upload(event) {
    return loadFile(event.target.files[0], event.data)
}

// The file input is hidden, because loadFile() clears it and it would then say "No file chosen" next to a loaded file.
// This button opens its file chooser instead, and like a file input it also takes a file dropped onto it.
function chooseFileButton(button, load) {
    button.addEventListener('click', () => load.input.click())
    button.addEventListener('dragover', event => event.dataTransfer.types.includes('Files') && event.preventDefault())
    button.addEventListener('drop', event => {
        const file = event.dataTransfer.files[0]
        if (file) {
            event.preventDefault()
            loadFile(file, load)
        }
    })
}

function updateNetworkStatus(status) {
    if (status) {
        $('#networkStatus')[0].style.background = 'green'
    } else {
        $('#networkStatus')[0].style.background = 'red'
    }
}

function isJson(string) {
    try {
        JSON.parse(string);
    } catch (e) {
        return false;
    }
    return true;
}

function saveAs(blob, fileName) {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = fileName
    link.click()
    // The download starts asynchronously, so revoking the URL right away could abort it.
    setTimeout(() => URL.revokeObjectURL(link.href), 40000)
}

function downloadResult() {
    let content = resultEditor.getValue();
    if (isXml(content)) {
        let blob = new Blob([content], {type: "application/xml;charset=utf-8"});
        saveAs(blob, 'Result.xml');
        return;
    }
    let blob = new Blob([content], {type: "application/json;charset=utf-8"});
    saveAs(blob, 'Result.json');
}

$(document).ready(function () {
    const sourceLoad = {
        input: $('#sourceUpload')[0],
        name: $('#sourceFileName')[0],
        read: readSourceFile,
        prettify: $('#sourcePrettify')[0],
        mode: text => isXml(text) ? 'xml' : 'json',
    }
    const sourceAutoProcess = debounced(() => autoProcess(), debounce)
    sourceEditor = new Editor(document.getElementById('sourceEditor'), {
        onChange: () => {
            disablePrettify(sourceLoad)
            sourceAutoProcess()
        },
        onDropFile: file => loadFile(file, sourceLoad),
    });
    sourceLoad.editor = sourceEditor
    $('#sourceUpload').change(sourceLoad, upload);
    chooseFileButton($('#sourceChoose')[0], sourceLoad);
    $('#sourcePrettify').change(() => showLoaded(sourceLoad));

    const mappingLoad = {
        input: $('#mappingUpload')[0],
        name: $('#mappingFileName')[0],
        read: file => file.text(),
        prettify: $('#mappingPrettify')[0],
        // A template gets XML highlighting without the XSLT error check, which would run it right away.
        // processFields() switches the editor to XSLT after its run.
        mode: text => isXml(text) ? 'xml' : 'jq',
    }
    const mappingAutoProcess = debounced(() => autoProcess(), debounce)
    mappingEditor = new Editor(document.getElementById('mappingEditor'), {
        onChange: () => {
            disablePrettify(mappingLoad)
            mappingAutoProcess()
        },
        onDropFile: file => loadFile(file, mappingLoad),
    });
    mappingLoad.editor = mappingEditor
    $('#mappingUpload').change(mappingLoad, upload);
    chooseFileButton($('#mappingChoose')[0], mappingLoad);
    $('#mappingPrettify').change(() => showLoaded(mappingLoad));

    resultEditor = new Editor(document.getElementById('resultEditor'), {readOnly: true});

    $('#layout').on('change', (event) => {
        $('.content').get(0).style.gridTemplateAreas = $(event.target).val()
    })

    $('#jqRaw').on('change', () => autoProcess())

    $('#autoRun').change(function () {
        if (this.checked) {
            resultEditor.setMessage(null)
            $('#run').hide()
            processFields();
        } else {
            $('#run').show()
        }
    });

    $('#run').click(processFields);

    $('#downloadResult').click(downloadResult);

    updateNetworkStatus(navigator.onLine)
    window.addEventListener("online", () => {
        updateNetworkStatus(true);
    });

    window.addEventListener("offline", () => {
        updateNetworkStatus(false);
    });

    $('#version').text('v' + VERSION);

    $('#autoMapButton').click(autoMap)
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').then(registration => {
        }).catch(registrationError => {
            console.log('SW registration failed: ', registrationError);
        });
    });
}

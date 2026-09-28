import $ from 'jquery'
import {loadJq} from 'jq-wasm'
import xmlFormat from 'xml-formatter'

import {EditorView, basicSetup} from 'codemirror'
import {keymap} from '@codemirror/view'
import {insertTab, indentSelection} from '@codemirror/commands'
import {EditorState, Compartment} from '@codemirror/state'
import {StreamLanguage, indentUnit} from '@codemirror/language'
import {simpleMode} from '@codemirror/legacy-modes/mode/simple-mode'
import {xml} from '@codemirror/lang-xml'
import {json, jsonParseLinter} from '@codemirror/lang-json'
import {linter, lintGutter, setDiagnostics} from '@codemirror/lint'
import {oneDark} from '@codemirror/theme-one-dark'

import './style.css'

const debounce = 600;

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

const languages = {
    xml: () => xml(),
    xsl: () => [xml(), linter(xslValidator)],
    json: () => [json(), linter(jsonParseLinter())],
    jq: () => [jqLanguage, linter(jqValidator)],
}

class Editor {
    constructor(parent, {readOnly = false, onChange = null} = {}) {
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
                onChange ? EditorView.updateListener.of(update => update.docChanged && onChange()) : [],
            ],
        })
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
    try {
        runXsl3(sourceEditor.getValue(), text)
        return []
    } catch (exception) {
        let lineNumber = 0
        let searchLineNumber = exception.message.match(/(?<=on line )\d+(?= )/m)
        if (searchLineNumber && !exception.xsltModule) {
            lineNumber = parseInt(searchLineNumber[0]) - 1
        }
        let searchError = exception.message.match(/(?<= in \/ {).+(?=}: )/)
        if (searchError) {
            let searchErrorInText = text.match(new RegExp(filterForRegex(searchError[0])))
            if (searchErrorInText) {
                lineNumber = lineNumberOfIndex(text, searchErrorInText.index) - 1
            }
        }
        return [lineDiagnostic(doc, lineNumber, exception.message)]
    }
}

// XML that does not parse is returned unchanged: without strictMode the parser would add the closing tags missing from
// truncated or malformed input. The line separator is set because it defaults to \r\n.
function formatXml(text) {
    return xmlFormat(text, {indentation: '    ', collapseContent: true, lineSeparator: '\n', strictMode: true, throwOnFailure: false})
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

function filterForRegex(str) {
    return str.replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1");
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
            try {
                result = await runXsl3(source, mapping) ?? ''
            } catch (e) {
            }
        }

        setEditorModes(source, mapping, result)

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

function runXsl3(source, mapping) {
    let saxonPlatform = SaxonJS.getPlatform()
    let mappingDoc = saxonPlatform.parseXmlFromString(mapping)
    let sourceUrl = URL.createObjectURL(new Blob([source]));
    let sourceLocation, stylesheetParams;

    if (isJson(source) && isXml(mapping)) {
        stylesheetParams = {
            jsonUri: `${sourceUrl}`,
        };

        mappingDoc.children[0].insertAdjacentHTML('afterbegin', `
            <xsl:param name="jsonUri"/>
            <xsl:template name="xsl:initial-template">
                <xsl:variable name="jsonText" select="unparsed-text($jsonUri)"/>
                <xsl:variable name="jsonXml" select="json-to-xml($jsonText)"/>

                <xsl:variable name="cleanXml">
                    <xsl:apply-templates select="$jsonXml" mode="removeNamespace"/>
                </xsl:variable>

                <xsl:apply-templates select="$cleanXml"/>
            </xsl:template>

            <!-- Template to remove the namespace -->
            <xsl:template match="*" mode="removeNamespace">
                <xsl:element name="{local-name()}">
                    <xsl:apply-templates select="@* | node()" mode="removeNamespace"/>
                </xsl:element>
            </xsl:template>
            <xsl:template match="@*" mode="removeNamespace">
                <xsl:attribute name="{local-name()}">
                    <xsl:value-of select="."/>
                </xsl:attribute>
            </xsl:template>
       `)

    } else {
        sourceLocation = sourceUrl;
    }

    window.mappingDoc = mappingDoc
    mappingDoc._saxonBaseUri = "file:///"
    let compiledMapping = JSON.stringify(SaxonJS.compile(mappingDoc))
    let compiledMappingUrl = URL.createObjectURL(new Blob([compiledMapping]))
    let result = SaxonJS.transform({
        stylesheetLocation: compiledMappingUrl,
        stylesheetParams,
        sourceLocation,
        destination: 'serialized',
        sourceType: source.startsWith('{') || source.startsWith('[') ? 'json' : 'xml',
    }).principalResult

    if (isJson(result.trim())) {
        return JSON.stringify(JSON.parse(result), null, 4)
    }

    if (isXml(result)) {
        return formatXml(result)
    }

    return result
}

async function upload(event) {
    let content = await $(event.target).prop('files')[0].text()
    let newLines = content.match(/\n/g) ?? []
    if (isXml(content) && newLines.length <= 2) {
        content = formatXml(content)
    }
    if (!isXml() && newLines.length <= 2) {
        try {
            content = formatJson(content)
        } catch (e) {
        }
    }

    if (content.split("\n").length > 1000) {
        $('#autoRun').prop('checked', false);
        $('#autoRun').trigger('change');
    }

    event.data.editor.setValue(content)
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
    sourceEditor = new Editor(document.getElementById('sourceEditor'), {onChange: debounced(() => autoProcess(), debounce)});
    $('#sourceUpload').change({editor: sourceEditor}, upload);

    mappingEditor = new Editor(document.getElementById('mappingEditor'), {onChange: debounced(() => autoProcess(), debounce)});
    $('#mappingUpload').change({editor: mappingEditor}, upload);

    resultEditor = new Editor(document.getElementById('resultEditor'), {readOnly: true});

    $('#layout').on('change', (event) => {
        $('.content').get(0).style.gridTemplateAreas = $(event.target).val()
    })

    $('#jqRaw').on('change', () => autoProcess())

    $('#autoRun').change(function () {
        if (this.checked) {
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

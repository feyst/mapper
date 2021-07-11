import $ from 'jquery'
import _ from 'underscore'
import jq from 'jq-web/jq.wasm'

import CodeMirror from 'codemirror/lib/codemirror'
import 'codemirror/mode/xml/xml'
import 'codemirror/mode/javascript/javascript'
import 'codemirror/addon/mode/simple'
import jsonlint from 'jsonlint-mod/web/jsonlint'
import 'codemirror/addon/lint/lint'
import 'codemirror/addon/hint/javascript-hint'
import 'codemirror/addon/lint/javascript-lint'
import 'codemirror/addon/lint/html-lint'
import 'codemirror/addon/lint/json-lint'
import 'codemirror/addon/edit/closetag'
import 'codemirror/addon/fold/xml-fold'
import 'codemirror/addon/fold/foldcode'
import 'codemirror/addon/fold/foldgutter'
import 'codemirror/addon/edit/matchtags'
import 'codemirror/addon/edit/matchbrackets'
import 'codemirror/addon/edit/closebrackets'
import 'codemirror/addon/scroll/simplescrollbars'
import vkbeautify from 'vkbeautify'

import 'codemirror/lib/codemirror.css'
import 'codemirror/theme/darcula.css'
import 'codemirror/addon/lint/lint.css'
import 'codemirror/addon/scroll/simplescrollbars.css'
import './style.css'

window.jsonlint = jsonlint

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

CodeMirror.defineSimpleMode('jq', jqMode);

let sourceEditor, mappingEditor, resultEditor;

const generalOptions = {
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'darcula' : 'default',
    lineNumbers: true,
    matchBrackets: true,
    indentUnit: 4,
    autocorrect: true,
    foldGutter: true,
    lint: true,
    lintOnChange: true,
    highlightLines: true,
    gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers", "CodeMirror-foldgutter"],
    readOnly: false,
    scrollbarStyle: 'simple',
    // scrollbarStyle: null,
}
const xmlOptions = {
    mode: "application/xml",
    alignCDATA: true,
    htmlMode: false,
    autoCloseTags: true,
    matchTags: true,
};
const xslOptions = {
    ...xmlOptions,
    ...{
        lint: {
            'getAnnotations': xslValidator,
            async: true,
        }
    }
}
const jsonOptions = {
    mode: "application/json",
    autoCloseBrackets: true,
}

const jqOptions = {
    mode: 'jq',
    lint: {
        'getAnnotations': jqValidator,
        async: true,
    },
}
const readOnlyOptions = {
    readOnly: 'nocursor',
    lint: false,
}

function jqValidator(text, updateLinting) {
    let errors = [];
    try {
        jq.json({}, text)
    } catch (e) {
        errors = e.stack.split('jq: ')
        errors = errors.filter(error => error !== '' && !error.match(/\d+ compile error/g))
        errors = errors.map(error => {
            let lineNumber = error.match(/(?<=, line )\d+(?=:$)/m)
            if (lineNumber) {
                lineNumber = lineNumber[0]
            } else {
                lineNumber = 2
            }
            return {
                from: {
                    line: lineNumber - 1,
                    ch: 0,
                    sticky: null,
                },
                to: {
                    line: lineNumber - 1,
                    ch: 999,
                    sticky: null,
                },
                message: error,
                severity: 'error',
            }
        })
    }
    updateLinting(errors)
}

function xslValidator(text, updateLinting) {
    let errors = [];
    try {
        runXsl3(sourceEditor.getValue(), mappingEditor.getValue())
    } catch (exception) {
        let lineNumber = 0
        let searchLineNumber = exception.message.match(/(?<=on line )\d+(?= )/m)
        if ( searchLineNumber && !exception.xsltModule) {
            lineNumber = parseInt(searchLineNumber[0]) - 1
        }
        let searchError = exception.message.match(/(?<= in \/ {).+(?=}: )/)
        if (searchError) {
            let searchErrorInText = text.match(new RegExp(filterForRegex(searchError[0])))
            if (searchErrorInText) {
                lineNumber = lineNumberOfIndex(text, searchErrorInText.index) - 1
            }
        }
        errors = [
            {
                from: {
                    line: lineNumber,
                    ch: 0,
                    sticky: null,
                },
                to: {
                    line: lineNumber,
                    ch: 999,
                    sticky: null,
                },
                message: exception.message,
                severity: 'error',
            }
        ]
    }
    updateLinting(errors)
}
function filterForRegex(str) {
    return str.replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1");
}

function lineNumberOfIndex(text, index){
    let beforeText = text.substr(0, index)

    return beforeText.split('\n').length
}

function setOptions(editor, options) {
    Object.entries(options).forEach(option => editor.setOption(option[0], option[1]))
}

function isXml(string) {
    return null != string && string.match(/^</)
}

function setEditorOptions(source, mapping, result) {
    if (isXml(source) && 'application/xml' !== sourceEditor.getOption('mode')) {
        setOptions(sourceEditor, {...generalOptions, ...xmlOptions})
    } else if (!isXml(source) && 'application/json' !== sourceEditor.getOption('mode')) {
        setOptions(sourceEditor, {...generalOptions, ...jsonOptions})
    }
    if (isXml(mapping) && 'application/xml' !== mappingEditor.getOption('mode')) {
        setOptions(mappingEditor, {...generalOptions, ...xslOptions})
        $('#jqRawOption')[0].style.display = 'none'
    } else if (!isXml(mapping) && 'application/json' !== mappingEditor.getOption('mode') && mapping !== '') {
        setOptions(mappingEditor, {...generalOptions, ...jqOptions})
        $('#jqRawOption')[0].style.display = 'inline'
    }
    if (isXml(result) && 'application/xml' !== resultEditor.getOption('mode')) {
        setOptions(resultEditor, {...generalOptions, ...xmlOptions, ...readOnlyOptions})
    } else if (!isXml(result) && 'application/json' !== resultEditor.getOption('mode')) {
        setOptions(resultEditor, {...generalOptions, ...jsonOptions, ...readOnlyOptions})
    }
}

async function processFields() {
    let result = '';
    let source = sourceEditor.getValue()
    let mapping = mappingEditor.getValue()

    if (!isXml(source) && !isXml(mapping)) {
        result = await runJq(source, mapping) ?? ''
    }

    if (isXml(source) && isXml(mapping)) {
        try {
            result = await runXsl3(source, mapping) ?? ''
        } catch (e) {
        }
    }

    setEditorOptions(source, mapping, result)

    let scroll = resultEditor.getScrollInfo()
    resultEditor.setValue(result)
    resultEditor.scrollTo(scroll.left, scroll.top)
}

async function runJq(source, mapping) {
    try {
        let result;
        if ($('#jqRaw')[0].checked) {
            result = await jq.promised.raw(JSON.stringify(JSON.parse(source)), mapping, ['-r'])
        } else {
            result = JSON.stringify(await jq.promised.json(JSON.parse(source), mapping))
        }
        try {
            result = vkbeautify.json(result)
        } catch (e) {
        }
        return result
    } catch (e) {
        return '';
    }
}

function runXsl(source, mapping) {
    try {
        let xmlParser = new DOMParser();
        let xslParser = new DOMParser();
        let xmlSerializer = new XMLSerializer();
        let processor = new XSLTProcessor();
        let xslDoc = xslParser.parseFromString(mapping, "application/xml");
        let xmlDoc = xmlParser.parseFromString(source, "application/xml");

        processor.importStylesheet(xslDoc);
        let resultDoc = processor.transformToDocument(xmlDoc);
        let resultXml = xmlSerializer.serializeToString(resultDoc);
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + vkbeautify.xml(resultXml)
    } catch (e) {
        console.log('Exception: ', e);
        return null;
    }
}

function runXsl3(source, mapping) {
    let saxonPlatform = SaxonJS.getPlatform()
    let mappingDoc = saxonPlatform.parseXmlFromString(mapping)
    window.mappingDoc = mappingDoc
    mappingDoc._saxonBaseUri = "file:///"
    let compiledMapping = JSON.stringify(SaxonJS.compile(mappingDoc))
    let compiledMappingUrl = URL.createObjectURL(new Blob([compiledMapping]))
    let sourceUrl = URL.createObjectURL(new Blob([source]));
    let resultXml = SaxonJS.transform({
        stylesheetLocation: compiledMappingUrl,
        sourceLocation: sourceUrl,
        destination: 'serialized'
    }).principalResult

    return vkbeautify.xml(resultXml)
}

async function upload(event) {
    let content = await $(event.target).prop('files')[0].text()
    let newLines = content.match(/\n/g) ?? []
    if (isXml(content) && newLines.length <= 2) {
        content = vkbeautify.xml(content)
    }
    if (!isXml() && newLines.length <= 2) {
        try {
            content = vkbeautify.json(content)
        } catch (e) {
        }
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

$(document).ready(function () {
    sourceEditor = CodeMirror(document.getElementById('sourceEditor'), generalOptions);
    sourceEditor.on('change', _.debounce(v => processFields(), debounce));
    sourceEditor.setSize(null, '100%')
    $('#sourceUpload').change({editor: sourceEditor}, upload);


    mappingEditor = CodeMirror(document.getElementById('mappingEditor'), generalOptions);
    mappingEditor.on('change', _.debounce(v => processFields(), debounce));
    mappingEditor.setSize(null, '100%')
    $('#mappingUpload').change({editor: mappingEditor}, upload);

    resultEditor = CodeMirror(document.getElementById('resultEditor'), {...generalOptions, ...readOnlyOptions});
    resultEditor.setSize(null, '100%')

    $('#layout').on('change', (event) => {
        $('.content').get(0).style.gridTemplateAreas = $(event.target).val()
    })

    $('#jqRaw').on('change', () => processFields())

    updateNetworkStatus(navigator.onLine)
    window.addEventListener("online", () => {
        updateNetworkStatus(true);
    });

    window.addEventListener("offline", () => {
        updateNetworkStatus(false);
    });
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').then(registration => {
        }).catch(registrationError => {
            console.log('SW registration failed: ', registrationError);
        });
    });
}
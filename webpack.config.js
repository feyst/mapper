const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const WorkboxPlugin = require('workbox-webpack-plugin')
const fs = require('fs');
const webpack = require('webpack');
const packageJson = require('./package.json');

// Emits the web app manifest and its icons under content-hashed names, so they can be cached indefinitely, and links
// the manifest and the SVG icon (as favicon and mask icon) from the generated index.html. Icon `src` values are paths
// relative to this config file.
class PwaManifestPlugin {
    constructor(manifest) {
        this.manifest = manifest
    }

    apply(compiler) {
        const {Compilation, sources, util} = compiler.webpack

        compiler.hooks.thisCompilation.tap('PwaManifestPlugin', compilation => {
            const {hashFunction, hashDigest, hashDigestLength} = compilation.outputOptions
            const hashedName = (name, extension, content) =>
                `${name}.${util.createHash(hashFunction).update(content).digest(hashDigest).slice(0, hashDigestLength)}${extension}`
            let manifestFile, svgIconFile

            compilation.hooks.processAssets.tap({name: 'PwaManifestPlugin', stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL}, () => {
                const icons = this.manifest.icons.map(icon => {
                    const source = path.resolve(__dirname, icon.src)
                    const content = fs.readFileSync(source)
                    const file = hashedName(`icon_${icon.sizes}`, path.extname(source), content)
                    compilation.fileDependencies.add(source)
                    compilation.emitAsset(file, new sources.RawSource(content), {immutable: true})
                    if ('image/svg+xml' === icon.type) {
                        svgIconFile = file
                    }
                    return {...icon, src: file}
                })
                const content = JSON.stringify({...this.manifest, icons}, null, 2)
                manifestFile = hashedName('manifest', '.json', content)
                compilation.emitAsset(manifestFile, new sources.RawSource(content), {immutable: true})
            })

            HtmlWebpackPlugin.getHooks(compilation).alterAssetTagGroups.tap('PwaManifestPlugin', data => {
                if (svgIconFile) {
                    data.headTags.push(HtmlWebpackPlugin.createHtmlTagObject('link', {rel: 'icon', href: svgIconFile}))
                    data.headTags.push(HtmlWebpackPlugin.createHtmlTagObject('link', {rel: 'mask-icon', href: svgIconFile}))
                }
                data.headTags.push(HtmlWebpackPlugin.createHtmlTagObject('link', {rel: 'manifest', href: manifestFile}))
                if (this.manifest.theme_color) {
                    data.headTags.push(HtmlWebpackPlugin.createHtmlTagObject('meta', {name: 'theme-color', content: this.manifest.theme_color}))
                }
                return data
            })
        })
    }
}

module.exports = (env, argv) => {
    let config = {
        entry: {
            main: './src/index.js',
            xsl: './lib/saxon/saxon-js/SaxonJS2.js',
        },
        mode: 'development',
        output: {
            filename: '[name].[contenthash].js',
            path: path.resolve(__dirname, 'dist'),
            clean: {
                keep: /^\.gitkeep$/,
            },
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: 'src/index.html'
            }),
            // Also provides the favicon, so it runs under `webpack serve` too.
            new PwaManifestPlugin({
                name: 'JQ and XSL mapper',
                short_name: 'Data mapper',
                description: 'A tool to map xml and json using JQ and XSL',
                orientation: 'portrait',
                display: 'standalone',
                start_url: '.',
                background_color: '#ffffff',
                theme_color: '#ffffff',
                icons: [
                    {
                        src: 'src/icon.svg',
                        sizes: '150x150',
                        type: 'image/svg+xml',
                    },
                    {
                        src: 'src/icon-512.png',
                        sizes: '512x512',
                        type: 'image/png',
                    },
                ],
            }),
            new webpack.DefinePlugin({
                VERSION: JSON.stringify(packageJson.version),
            }),
        ],
        optimization: {
            runtimeChunk: 'single',
            splitChunks: {
                cacheGroups: {
                    vendor: {
                        test: /[\\/]node_modules[\\/]/,
                        name: 'vendors',
                        chunks: 'all',
                    },
                },
            },
        },
        performance: {
            maxAssetSize: 2.5 * 1024 * 1024,
            maxEntrypointSize: 2.5 * 1024 * 1024,
        },
        module: {
            rules: [
                {
                    test: /\.css$/i,
                    use: ['style-loader', 'css-loader'],
                },
                {
                    test: /\.(png|svg|jpg|jpeg|gif)$/i,
                    type: 'asset/resource',
                },
            ],
        },
        resolve: {
            fallback: {
                crypto: false,
                stream: false,
                fs: false,
                util: false,
                path: false,
            }
        },
        devServer: {
            static: {
                directory:path.join(__dirname, 'dist'),
                watch: true,
            },
            watchFiles: {
                paths: ['src/index.html'],
                options: {
                    usePolling: false,
                },
            }
        },
    }

    if ('production' === argv.mode) {
        config.mode = 'production'
    }

    if(true !== argv.env.WEBPACK_SERVE) {
        config.plugins.push(
            new WorkboxPlugin.GenerateSW({
                // these options encourage the ServiceWorkers to get in there fast
                // and not allow any straggling "old" SWs to hang around
                clientsClaim: true,
                skipWaiting: true,
                maximumFileSizeToCacheInBytes: 99999999999999,
            }),
        );
    }

    return config;
};
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const WorkboxPlugin = require('workbox-webpack-plugin')
const WebpackPwaManifest = require('webpack-pwa-manifest')
const { ModifySourcePlugin } = require('modify-source-webpack-plugin');

module.exports = (env, argv) => {
    let config = {
        entry: {
            main: './src/index.js',
            xsl: './lib/saxon/2.2/SaxonJS2.js',
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
            new WorkboxPlugin.GenerateSW({
                // these options encourage the ServiceWorkers to get in there fast
                // and not allow any straggling "old" SWs to hang around
                clientsClaim: true,
                skipWaiting: true,
                maximumFileSizeToCacheInBytes: 99999999999999,
            }),
            new ModifySourcePlugin({
                rules: [
                    {
                        test: /SaxonJS2\.js$/,
                        modify: src => src.replace(/,xd:function\(n\)\{return/, ',xd:function(n){return true;return')
                    }
                ]
            }),
            new WebpackPwaManifest({
                publicPath: '/',
                name: 'JQ and XSL mapper',
                short_name: 'Data mapper',
                description: 'A tool to map xml and json using JQ and XSL',
                background_color: '#ffffff',
                theme_color: '#ffffff',
                icons: [
                    {
                        src: path.resolve('src/icon.svg'),
                        sizes: [150]
                    },
                    {
                        src: path.resolve('src/icon-512.png'),
                        sizes: [512]
                    },
                ]
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
                {
                    test: /\.html$/i,
                    loader: 'html-loader',
                },
            ],
        },
    }

    if('production' === argv.mode){
        config.mode = 'production'
    }

    return config
};
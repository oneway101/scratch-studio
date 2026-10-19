// Builds the editor from vendor/scratch-gui with our own entry point.
// Run from vendor/scratch-gui: webpack --config ../../webpack.config.js
const path = require('path');

const vendor = path.resolve(__dirname, 'vendor/scratch-gui');
const fromVendor = name => require(require.resolve(name, {paths: [vendor]}));
const webpack = fromVendor('webpack');
const HtmlWebpackPlugin = fromVendor('html-webpack-plugin');

const config = require(path.join(vendor, 'webpack.config.js'))[0];
const editorDir = path.resolve(__dirname, 'editor');

config.context = vendor;
config.entry = {studio: path.join(editorDir, 'studio.jsx')};
config.output.path = path.resolve(__dirname, 'build');
// Nearest node_modules first (scratch-vm pins older nested deps); the vendor root is for files in editor/.
config.resolve.modules = ['node_modules', path.join(vendor, 'node_modules')];
config.resolve.alias = Object.assign({}, config.resolve.alias, {
    '@gui': path.join(vendor, 'src'),
    '@studio': editorDir
});
config.resolveLoader = {modules: [path.join(vendor, 'node_modules')]};
config.module.rules[0].include.push(editorDir);
config.plugins = config.plugins
    .filter(plugin => !(plugin instanceof HtmlWebpackPlugin))
    .concat([
        new webpack.DefinePlugin({
            'process.env.STUDIO_ALLOWED_ORIGINS': JSON.stringify(
                process.env.STUDIO_ALLOWED_ORIGINS || 'http://localhost:8602'
            )
        }),
        new HtmlWebpackPlugin({
            chunks: ['studio'],
            template: path.join(vendor, 'src/playground/simple.ejs'),
            filename: 'index.html',
            title: 'Scratch Studio'
        })
    ]);

module.exports = config;

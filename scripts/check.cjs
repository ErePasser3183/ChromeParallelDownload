const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),extension=path.join(root,'extension');
const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if(pkg.version!==manifest.version)throw Error('Package and manifest versions differ');
for(const file of fs.readdirSync(extension))if(/\.(js|mjs)$/.test(file))execFileSync(process.execPath,['--check',path.join(extension,file)],{stdio:'inherit'});
for(const file of [manifest.background.service_worker,manifest.action.default_popup,manifest.options_page,...manifest.content_scripts.flatMap(s=>s.js)])if(!fs.existsSync(path.join(extension,file)))throw Error('Missing extension resource: '+file);
console.log('Extension syntax, manifest resources and version: PASS');

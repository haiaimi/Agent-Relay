import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {isIP} from 'node:net';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Loopback/bind addresses, documentation examples and protocol policy ranges are not deployment endpoints.
export function isPublicAddress(address){
  const family=isIP(address);if(!family)return false;
  if(family===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===192&&b===0&&c===2||a===198&&b===51&&c===100||a===203&&b===0&&c===113);
  }
  const value=address.toLowerCase(),first=Number.parseInt(value.split(':')[0]||'0',16);
  return first>=0x2000&&first<=0x3fff&&!value.startsWith('2001:db8:');
}
export function publicAddresses(text){
  const candidates=[...text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g),...text.matchAll(/(?<![\w:])(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}(?![\w:])/gi)];
  return candidates.filter(match=>isPublicAddress(match[0])).map(match=>({offset:match.index,address:match[0]}));
}
export function checkRepository(root){
  const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))],issues=[];
  for(const file of files){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(resolve(root,file)));}catch(error){if(error.code==='ENOENT'||error.code==='ERR_ENCODING_INVALID_ENCODED_DATA')continue;throw error;}
    for(const found of publicAddresses(text))issues.push({file,line:text.slice(0,found.offset).split('\n').length});
  }
  return {files:files.length,issues};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),result=checkRepository(root);
  if(result.issues.length){for(const issue of result.issues)console.error(`${issue.file}:${issue.line}: public IP literal must be replaced by an example domain or documentation address`);process.exitCode=1;}
  else console.log(`Checked ${result.files} repository files: no public IP literals.`);
}

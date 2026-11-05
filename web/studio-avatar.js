// A team's persisted UUID supplies the random seed. Portraits remain identical
// across browsers and devices without sending role names to an avatar service.
export function avatarData(teamId,role){
  let seed=2166136261;for(const char of teamId+':'+role)seed=Math.imul(seed^char.charCodeAt(0),16777619)>>>0;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const hue=next()%360,bg=`hsl(${hue} 32% 28%)`,shirt=`hsl(${(hue+50)%360} 48% 65%)`,skin=['#f3c8a4','#cc956d','#9b674c','#e5ad93'][next()%4],hair=['#26252b','#694a3c','#ded3ad','#b66348','#493d68'][next()%5],style=next()%4,glasses=next()%3===0;
  const tops=[`<path d="M15 31V24C15 5 50 5 50 25v8l-7-13-20 3-8 11Z"/>`,`<path d="M15 35V22C15 6 48 8 50 23L41 18 31 25 22 20Z"/>`,`<path d="M15 38V22C15 6 50 5 50 23V40H44V23L23 20v20H15Z"/>`,`<path d="M15 29V21C15 9 48 7 50 23L39 19 25 27Z"/>`];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${bg}"/><path d="M8 64c0-23 48-23 48 0" fill="${shirt}"/><rect x="26" y="38" width="12" height="15" rx="5" fill="${skin}"/><ellipse cx="32" cy="30" rx="17" ry="20" fill="${skin}"/><g fill="${hair}">${tops[style]}</g><g fill="#30282a"><circle cx="25" cy="31" r="1.8"/><circle cx="39" cy="31" r="1.8"/></g>${glasses?'<g stroke="#37303b" stroke-width="1.5" fill="none"><rect x="19" y="26" width="12" height="10" rx="4"/><rect x="33" y="26" width="12" height="10" rx="4"/><path d="M31 29h2"/></g>':''}<path d="M27 40q5 4 10 0" fill="none" stroke="#865645" stroke-width="2" stroke-linecap="round"/></svg>`;
  return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
}
export function roleAvatar(teamId,role,name){const image=document.createElement('img');image.className='role-avatar';image.src=avatarData(teamId,role);image.alt=name+'头像';image.width=40;image.height=40;return image;}

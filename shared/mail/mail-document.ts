/** Build an isolated, passive email document. Never insert sender HTML into the app DOM. */
export function mailDocument(html:string,images=false):{document:string;links:{href:string;text:string}[]}{
  const template=document.createElement('template');template.innerHTML=html.slice(0,500000);
  const allowed=new Set('div span p br hr table thead tbody tfoot tr td th col colgroup img a b strong i em u s small big sub sup h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code center font style'.split(' '));
  const attrs=new Set('style class id title alt width height align valign bgcolor color size face border cellpadding cellspacing colspan rowspan dir lang'.split(' '));
  /** Each destination with the text the sender showed for it, to spot links that pretend to go elsewhere. */
  const links:{href:string;text:string}[]=[];
  const css=(value:string)=>value.replace(/@import[^;]*(;|$)/gi,'').replace(/url\s*\([^)]*\)/gi,'none').replace(/expression\s*\([^)]*\)/gi,'').replace(/-moz-binding\s*:[^;]*/gi,'').replace(/behavior\s*:[^;]*/gi,'');
  const url=(value:string|null)=>{try{const parsed=new URL(value || '');return parsed.protocol==='https:' || parsed.protocol==='http:'?parsed.href:'';}catch{return '';}};
  // A snapshot includes descendants of removed elements; they remain detached.
  for(const element of Array.from(template.content.querySelectorAll('*'))){
    const tag=element.tagName.toLowerCase();
    if(!allowed.has(tag)){element.remove();continue;}
    const image=tag==='img'?url(element.getAttribute('src')):'';
    const href=tag==='a'?url(element.getAttribute('href')):'';
    if(href && !links.some(link=>link.href===href))links.push({href,text:(element.textContent || '').trim().slice(0,200)});
    if(tag==='style')element.textContent=css(element.textContent || '');
    for(const attribute of Array.from(element.attributes)){
      if(!attrs.has(attribute.name.toLowerCase()))element.removeAttribute(attribute.name);
    }
    if(element.hasAttribute('style'))element.setAttribute('style',css(element.getAttribute('style') || ''));
    if(tag==='a' && href)element.setAttribute('title','Este enlace no se abre desde aquí. Ábrelo en «Enlaces del mensaje», debajo del correo, donde NexoMail lo revisa antes.\nDestino: '+href);
    if(tag==='img'){
      const tiny=['width','height'].some(name=>{const value=Number(element.getAttribute(name));return element.hasAttribute(name) && value>=0 && value<=2;});
      if(!images || tiny || !image.startsWith('https:')){element.remove();continue;}
      element.setAttribute('src',image);element.setAttribute('referrerpolicy','no-referrer');element.setAttribute('loading','lazy');
    }
  }
  const policy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src "+(images?'https:':"'none'")+"; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  return {document:'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;padding:0;background:#fff;color:#202124;font:14px/1.6 Arial,sans-serif;overflow-wrap:anywhere}body{padding:16px;box-sizing:border-box}img{max-width:100%!important;height:auto!important}table{max-width:100%!important}pre{white-space:pre-wrap}a{color:#1769aa;text-decoration:underline dotted;cursor:help}*{box-sizing:border-box}</style></head><body>'+template.innerHTML+'</body></html>',links:links.slice(0,100)};
}

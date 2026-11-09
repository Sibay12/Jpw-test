
/* JPW theme preference: visual-only enhancement, does not touch authentication or API logic. */
(function(){
  var KEY='jpw_ui_theme';
  function apply(theme){
    var t=(theme==='dark')?'dark':'light';
    document.documentElement.setAttribute('data-jpw-theme',t);
    var b=document.getElementById('jpw-theme-toggle');
    if(b){b.innerHTML=(t==='dark'?'☀️ Light mode':'🌙 Dark mode');b.setAttribute('aria-label','Switch to '+(t==='dark'?'light':'dark')+' theme');}
  }
  var saved='dark';
  try{saved=localStorage.getItem(KEY)||'light';}catch(e){}
  apply(saved);
  function mount(){
    if(document.getElementById('jpw-theme-toggle'))return;
    var b=document.createElement('button');b.id='jpw-theme-toggle';b.type='button';
    b.addEventListener('click',function(){
      var next=document.documentElement.getAttribute('data-jpw-theme')==='dark'?'light':'dark';
      apply(next);try{localStorage.setItem(KEY,next);}catch(e){}
    });
    document.body.appendChild(b);apply(saved);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();

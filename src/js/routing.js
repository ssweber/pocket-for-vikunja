// The screen in the address: #/today, #/project/12 and so on.

export const currentRoute = () => routeOf(location.hash);
export function routeOf(hash){
  const h = hash.replace(/^#\/?/, '');
  const [path, q] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(q || '');
  if (parts[0] === 'projects') return {name:'projects'};
  if (parts[0] === 'search') return {name:'search'};
  if (parts[0] === 'checklists') return {name:'checklists'};
  if (parts[0] === 'run' && parts[1]) return {name:'run', id: +parts[1], step: +params.get('step') || null};
  if (parts[0] === 'project' && parts[1]) return {name:'project', id: +parts[1], showDone: params.get('done') === '1'};
  if (parts[0] === 'add') return {name:'add', text: params.get('text') || params.get('title') || ''};
  return {name:'today'};
}

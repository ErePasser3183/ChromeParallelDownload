export async function database() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('parallel-download',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('settings');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
export async function read(key) {
  const db=await database();
  try{return await new Promise((resolve,reject)=>{
    const request=db.transaction('settings').objectStore('settings').get(key);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });}finally{db.close();}
}
export async function write(key,value) {
  const db=await database();
  try{await new Promise((resolve,reject)=>{
    const transaction=db.transaction('settings','readwrite');
    if(value===undefined)transaction.objectStore('settings').delete(key);
    else transaction.objectStore('settings').put(value,key);
    transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
  });}finally{db.close();}
}

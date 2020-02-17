import fs = require('fs')
import repl = require('repl') // 'repl' here refers to the module named 'repl' in index.d.ts
import { createContext, IOptions, parseError, runInContext } from '../index'

function startRepl(chapter = 1, useSubst: boolean, prelude = '') {
  // use defaults for everything
  const context = createContext(chapter)
  const options: Partial<IOptions> = { scheduler: 'preemptive', useSubst }
  runInContext(prelude, context, options).then(preludeResult => {
    if (preludeResult.status === 'finished') {
      console.log(preludeResult.value)
      repl.start(
        // the object being passed as argument fits the interface ReplOptions in the repl module.
        {
          eval: (cmd, unusedContext, unusedFilename, callback) => {
            runInContext(cmd, context, options).then(obj => {
              if (obj.status === 'finished') {
                callback(null, obj.value)
              } else {
                callback(new Error(parseError(context.errors)), undefined)
              }
            })
          }
        }
      )
    } else {
      throw new Error(parseError(context.errors))
    }
  })
}

function main() {
  const firstArg = process.argv[2]
  if (process.argv.length === 3 && String(Number(firstArg)) !== firstArg.trim()) {
    fs.readFile(firstArg, 'utf8', (err, data) => {
      if (err) {
        throw err
      }
      startRepl(4, false, data)
    })
  } else {
    const chapter = process.argv.length > 2 ? parseInt(firstArg, 10) : 1
    const useSubst = process.argv.length > 3 ? process.argv[3] === 'subst' : false
    startRepl(chapter, useSubst)
  }
}

main()

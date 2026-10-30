import unittest, tempfile
from pathlib import Path
from audit_data import placeholders, audit, Obj
import json

class AuditTests(unittest.TestCase):
    def test_printf_and_escaped_percent(self):
        self.assertEqual(placeholders('N%s %% {name}'),(['name'],{'%s':1}))
        self.assertEqual(placeholders('%s %s')[1],{'%s':2})
    def test_missing_empty_and_brand(self):
        found=audit({'a':'Текст','b':'Привет','c':'GrandCoins'},{'b':'','c':'GrandCoins'})
        self.assertEqual([f['issue_type'] for f in found],['untranslated','untranslated'])
    def test_duplicates_retained(self):
        o=json.loads('{"k":"first","k":"second"}',object_pairs_hook=Obj)
        self.assertEqual(o['k'],'second')
        self.assertEqual(o.duplicates,['k'])
        self.assertEqual(len(o.pairs),2)

if __name__=='__main__': unittest.main()

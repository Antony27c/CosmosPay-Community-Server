import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export type PayerRulesLike = {
  transfers_allowed_tax_id?: string;
  pse_full_name?: string;
  pse_document_type?: string;
  pse_document_number?: string;
  pse_email?: string;
  pse_bank_code?: string;
};

const PSE_REQUIRED_FIELDS = [
  'pse_full_name',
  'pse_document_type',
  'pse_document_number',
  'pse_email',
  'pse_bank_code',
] as const;

/**
 * Pure check used by the class-level decorator (and easy to unit-test alone).
 * Returns an error message in Cosmos Pay vocabulary, or null when valid.
 */
export function validatePayerRules(
  paymentMethod: string | undefined,
  payerRules: PayerRulesLike | undefined,
): string | null {
  if (paymentMethod === 'transfers') {
    const taxId = payerRules?.transfers_allowed_tax_id;
    if (typeof taxId !== 'string' || taxId.length === 0) {
      return (
        "payment_method 'transfers' requires payer_rules.transfers_allowed_tax_id " +
        '(Argentine CUIT/CUIL)'
      );
    }
    return null;
  }

  if (paymentMethod === 'pse') {
    const missing = PSE_REQUIRED_FIELDS.filter((field) => {
      const value = payerRules?.[field];
      return typeof value !== 'string' || value.length === 0;
    });
    if (missing.length > 0) {
      return (
        "payment_method 'pse' requires payer_rules with " +
        'pse_full_name, pse_document_type, pse_document_number, pse_email, and pse_bank_code'
      );
    }
    return null;
  }

  return null;
}

@ValidatorConstraint({ name: 'payerRulesMatchPaymentMethod' })
export class PayerRulesMatchPaymentMethodConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const obj = args.object as {
      payment_method?: string;
      payer_rules?: PayerRulesLike;
    };
    return validatePayerRules(obj.payment_method, obj.payer_rules) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const obj = args.object as {
      payment_method?: string;
      payer_rules?: PayerRulesLike;
    };
    return (
      validatePayerRules(obj.payment_method, obj.payer_rules) ??
      'payer_rules does not match payment_method'
    );
  }
}

/**
 * Class-level decorator: `payment_method` lives on the parent DTO, so nested
 * `@ValidateIf` inside `PayerRulesDto` cannot see it. Apply on `CreatePayinQuoteDto`.
 *
 * Registered against `payment_method` (always present) so `@IsOptional()` on
 * `payer_rules` cannot skip this check when the nested object is absent.
 */
export function PayerRulesMatchPaymentMethod(
  validationOptions?: ValidationOptions,
) {
  return function (constructor: new (...args: unknown[]) => object) {
    registerDecorator({
      name: 'payerRulesMatchPaymentMethod',
      target: constructor,
      propertyName: 'payment_method',
      options: validationOptions,
      validator: PayerRulesMatchPaymentMethodConstraint,
    });
  };
}
